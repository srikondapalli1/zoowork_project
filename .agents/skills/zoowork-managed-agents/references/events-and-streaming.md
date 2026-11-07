# ZooWork Managed Agents - Events and Streaming

Everything an agent does inside a session is an event. You drive a session by posting a small set
of inbound events, and you observe it by reading the outbound event log - either as a durable REST
list or as a live SSE stream. Both return the same normalized objects, so the choice is about
latency, not shape. Every call below needs an `agt_` id whose `status.desired_state` is already
`running`; see `SKILL.md` - Minimal lifecycle if you do not have one.

---

## The event model

The event log is per session. Every event carries a `seq` that is monotonic within that session and
never reused (gaps are normal - the sequence is strictly increasing, not contiguous). The log is
**bidirectional**: your own inputs echo back as `user.message`, `user.interrupt`,
`user.tool_confirmation`, `user.custom_tool_result` and `system.message` alongside the engine's output, so the whole
conversation reconstructs from this one surface. Pagination and stream resume run on cursors: a
list page's `nextCursor`, or the `cursor` token on each streamed event. Persist the last cursor you
successfully processed next to your session id. The token is opaque and is not interchangeable
with `seq`. A restart can resume the log; atomically checkpoint your own durable effects when
needed. Resume alone is not an exactly-once guarantee for your application.

The wire spells the same event differently per lane: on the default unified lane both transports
send one snake_case object (`event_type`, `run_id`, `processed_at`, `created_at`) and the SSE
`id:` line carries the resume token; on the deprecated `after` lane, REST stays snake_case while
SSE frames arrive camelCase. **No shape carries a top-level `type`.** The SDK absorbs all of it in
`normalizeEvent`, so `listEvents`, `listAllEvents` and `streamEvents` all hand you the same object
and you switch on a single field:

```ts
interface SessionEvent {
  /** Durable per-session sequence: strictly increasing, not necessarily contiguous. */
  seq: number
  eventType: SessionEventType | PublicInputEventType | string
  payload: Record<string, unknown>
  runId?: string          // absent on your echoed inputs
  turn?: number
  createdAt?: string
  id?: string             // event id, when the server sends one
  processedAt?: string | null  // inputs only: null while queued, a timestamp once consumed
  cursor?: string         // resume token, present on streamed events
}
```

Details that decide how you write the consumer:

- `eventType` is `SessionEventType | string` on purpose: an unrecognized type passes through instead
  of throwing, because the API may add types within a version. Your `switch` needs a default arm
  that ignores rather than one that throws.
- `payload` is always an object, `{}` rather than `undefined` when the frame carried none. Its keys
  are camelCase on both transports - only the envelope differs. `runId`, `turn` and `createdAt` are
  omitted entirely rather than set to `undefined` when absent.
- `seq` is `-1` when no sequence can be read. A numeric legacy SSE ID can backfill it, but an
  opaque unified ID is a cursor, not a number: never parse it as a sequence.

TypeScript exports `normalizeEvent(raw, sseId)` and Python exports `normalize_event(raw, sse_id)`,
so a custom transport
(a browser `EventSource`, a proxy in another process) can reuse it rather than re-deriving both
mappings. In Python, normalized fields use snake_case: `event_type`, `run_id`, `created_at`, and
`processed_at`.
There is no top-level `type`, no `session.status_*` event, no `span.*` event, and no turn-level
stop reason: switch on `event.eventType`, and end the turn on `run.finished`. An assistant message
does carry the provider's `stopReason` inside its own payload (see Reading history over REST), but
that is a property of one message, not a turn signal.

---

## The vocabulary

`SESSION_EVENT_TYPES` is exported as a runtime array of exactly these 20 entries, in this order.
Your own inputs additionally echo back as the five `PUBLIC_INPUT_EVENT_TYPES` (`user.message`,
`user.interrupt`, `user.tool_confirmation`, `user.custom_tool_result`, `system.message`) - see the table's last rows. The
`types=` filter on the history read accepts both lists; anything else is `400 invalid_request`.

| Type | What it means | Act on it? |
|---|---|---|
| `run.started` | A turn began, before any model call. `payload`: `trigger`, `inboundMessageId`, `agentId`. | Yes - mark the turn in flight |
| `run.finished` | The turn is over; the last event of the turn. `payload.status` is `succeeded` / `failed` / `aborted`. | Yes - the only verdict, and your loop exit |
| `chat.delta` | Preview lane, not the durable log. | No - see What not to build on |
| `chat.final` | Preview lane. | No |
| `chat.aborted` | Preview lane. | No |
| `chat.error` | Preview lane. | No |
| `agent.lifecycle` | Bookends the agent loop inside a turn. `start` and `end` are the recorded values of `phase`; the API reference declares a `heartbeat-skipped` phase for scheduled agents, which has not been observed here. | Rarely - useful for tracing |
| `agent.assistant` | One assistant message segment was committed. `payload.message` is `{ role, content[] }`, plus a 1-based `segment`. | Yes - this is the reply text |
| `agent.thinking` | Reasoning text for the segment just committed. `payload.text`. | Yes, if you render reasoning |
| `agent.tool` | A tool call changed phase. See Rendering below. | Yes - tool UI |
| `agent.item` | Internal loop markers (`kind`: `assistant_segment`, `llm_request`), not conversation. | No - skip when rendering a chat |
| `agent.plan` | Reserved in the vocabulary. The core loop does not emit it. | No |
| `agent.approval` | A tool call needs an approval, or one resolved. `phase`: `requested` / `resolved`. | Only for human-in-the-loop |
| `agent.custom_tool_use` | An application-executed tool was requested or resolved. Use `customToolUse()` / `custom_tool_use()`. | Yes, when the application owns execution |
| `agent.command_output` | A command-running tool produced stdout/stderr, at result granularity. | Optional |
| `agent.patch` | An `apply_patch` tool call succeeded. | Optional |
| `agent.compaction` | History was compacted to fit the context window. `tokensBefore`, `reason`. | Telemetry only |
| `agent.error` | An error occurred inside the turn. `errorMessage`, sometimes `kind`, `server` and optional `reason`. | Yes - log it, but it is not the verdict |
| `attachment.created` | A tool produced a file. `source`, `toolName`, `toolCallId`, storage refs. | Yes, if you surface files |
| `message.outbound` | The agent sent a proactive message (message tool, schedule announce, heartbeat) instead of replying in-session. | Only for proactive agents |
| `user.message` (echo) | Your own message, echoed into the log. `payload.content` is a block array (`messageText` reads it); `processedAt` is `null` until the agent consumes it. | Yes - the user side of the chat |
| `user.interrupt` / `user.tool_confirmation` / `user.custom_tool_result` / `system.message` (echo) | Your other inputs, echoed with their payloads. | Optional - render if you show them |

MCP catalog failures surface as `agent.error` with `kind: 'mcp_connection_failed'` (observed in
production for unreachable and private-address servers) or `mcp_authentication_failed`.
Preserve unknown `reason` values. Transient failed catalogs can expire so a later resolution
may probe again; this is not a periodic recovery guarantee or an automatic business-operation retry.
Healthy catalogs remain tied to the configuration.

Seven carry real integrations: `run.started`, `run.finished`, `agent.assistant`, `agent.thinking`,
`agent.tool`, `agent.error` and the echoed `user.message`. Handling only those renders a correct
two-sided chat.

**Payload fields for the rarer types are a guide, not a contract.** The arc observed repeatedly on
live sessions is `run.started`, `agent.lifecycle`, `agent.item`, `agent.thinking`,
`agent.assistant`, `agent.tool` (start then end), `agent.lifecycle`, `run.finished`. Production
checks on 2026-10-03 also drove `agent.approval` (`requested`, then `resolved`) followed by
`agent.tool` `end` after an allow decision or `blocked` with `deniedReason: 'approval-denied'`
after a deny. `agent.command_output`, `agent.patch`, `agent.compaction`, `attachment.created` and
`message.outbound` have not been driven end to end through this API, so code defensively against
their fields. (The echoed input events are verified: posting,
echo, `processedAt`, cursor resume and retry dedup were driven end to end on 2026-08-19.)

---

## The read loop

`streamEvents` is an async generator, not a promise. The one thing you must get right: **the stream
is session-scoped and does not close when a turn ends**. `run.finished` ends the turn, not the
connection; the server holds it open for the next turn and drops it only after an idle period. A
`for await` that runs to completion - or an `await` on an array collected from the generator -
blocks until that idle timeout fires. Break on `isRunFinished(ev)` yourself.

```ts
import {
  createZooworkClient, assistantText, thinkingText, toolCall, isRunFinished, runOutcome,
} from '@zoowork-ai/sdk'

const zc = createZooworkClient()                        // reads ZOOWORK_API_KEY
const agentId = process.env.ZOOWORK_AGENT_ID!           // agt_..., created and started once at setup

const session = await zc.createSession(agentId, {
  initial_events: [{ type: 'user.message', content: 'What is our refund window?' }],
})

const ctl = new AbortController()
const budget = setTimeout(() => ctl.abort(), 120_000)   // a stuck run must not hang the process

let text = ''
let cursor: string | undefined
let outcome: 'succeeded' | 'failed' | 'aborted' | undefined
const failedTools: string[] = []

try {
  for await (const ev of zc.streamEvents(agentId, session.session_id, { signal: ctl.signal })) {
    cursor = ev.cursor ?? cursor                        // the resume token - persist it
    text += assistantText(ev)                           // '' for every non agent.assistant event

    const think = thinkingText(ev)
    if (think) console.log(`[${ev.seq}] thinking: ${think.slice(0, 60)}`)
    const tool = toolCall(ev)
    if (tool?.phase === 'end' && tool.isError) failedTools.push(tool.toolName) // does NOT fail the run

    if (isRunFinished(ev)) {
      outcome = runOutcome(ev)                          // 'succeeded' | 'failed' | 'aborted'
      break                                             // required: the stream will not end on its own
    }
  }
} finally {
  clearTimeout(budget)
  ctl.abort()                                           // releases the HTTP body the generator left open
}
console.log(outcome, text.trim(), failedTools)
```

Mechanics worth knowing:

- `{ cursor }` resumes from right after that event. Never pass `event.seq` as `after`: `after`
  is a deprecated lane with its own numbering and no echoed inputs, so a unified `seq` there
  silently skips and renumbers events. Use `after` only with a value you stored from that lane.
- Aborting the signal ends the generator cleanly - the SDK swallows its own abort and returns
  instead of throwing, so you do not need a `catch` for your own cancellation. The flip side is in
  Reconnecting: a clean end no longer tells you which of the two things happened.
- The generator drops any event whose `seq` is at or below the highest it has already yielded, so a
  boundary event replayed by the server is never delivered twice within one generator instance.
- For a multi-turn session, open a fresh stream per turn with the last `cursor` rather than
  holding one open and counting `run.finished` events. It is easier to reason about, and it is what
  the reconnect wrapper below assumes.

---

## Reconnecting

**The SDK does not reconnect for you.** `streamEvents` opens exactly one `GET .../events/stream`
request and the generator ends when that response body ends. There is no retry, no backoff and no
auto-resume anywhere in the SDK - looping is the caller's job, and an integration that omits the
loop looks fine in testing and then silently stops receiving events in production.

What the server gives you in exchange is server-side resume. Every durable frame carries its
resume token in the SSE `id:` line, handed back as `ev.cursor`; pass `{ cursor }` and the server
replays the log from right after that event before continuing live - no client-side buffer to
keep, and no gap if the reconnect takes a while.
Within one generator, the SDK drops frames at or below its highest yielded `seq`. That state is
not an application checkpoint and is not retained across a new generator. Persist cursors after
successful processing and make external side effects idempotent where needed. The one subtlety: a caller
abort and an idle server close both end the generator the same quiet way, so check the signal to
tell them apart or a user who cancelled gets reconnected to.

```ts
import {
  ZooworkError, assistantText, isRunFinished, runOutcome,
  type SessionEvent, type ZooworkClient,
} from '@zoowork-ai/sdk'

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })

export interface TurnResult {
  outcome?: 'succeeded' | 'failed' | 'aborted'
  text: string
  cursor?: string                       // valid to resume from even when outcome is undefined
}

export async function streamTurn(
  zc: ZooworkClient,
  agentId: string,
  sessionId: string,
  opts: { cursor?: string; signal?: AbortSignal; maxAttempts?: number; onEvent?: (ev: SessionEvent) => void } = {},
): Promise<TurnResult> {
  const maxAttempts = opts.maxAttempts ?? 6
  let cursor = opts.cursor
  let text = ''

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // One controller per attempt: aborting it in `finally` frees the socket when we stop reading.
    const attemptCtl = new AbortController()
    const relay = () => attemptCtl.abort()
    opts.signal?.addEventListener('abort', relay, { once: true })
    if (opts.signal?.aborted) attemptCtl.abort()

    try {
      for await (const ev of zc.streamEvents(agentId, sessionId, {
        ...(cursor ? { cursor } : {}), // opaque query token; do not replace with after/seq
        signal: attemptCtl.signal,
      })) {
        opts.onEvent?.(ev)             // do not checkpoint a failed callback
        text += assistantText(ev)
        cursor = ev.cursor ?? cursor   // persist after successful processing
        if (isRunFinished(ev)) {
          const outcome = runOutcome(ev)
          return { ...(outcome ? { outcome } : {}), text, ...(cursor ? { cursor } : {}) }
        }
      }
      // Generator ended without run.finished. Either the caller aborted (checked below) or the
      // server closed an idle connection - the normal case, and not an error.
    } catch (e) {
      // 4xx is a real problem: unknown id, archived session, revoked key. Retrying cannot fix it.
      if (e instanceof ZooworkError && e.status >= 400 && e.status < 500) throw e
      // Everything else - socket reset, 5xx, DNS - is worth another attempt.
    } finally {
      opts.signal?.removeEventListener('abort', relay)
      attemptCtl.abort()
    }

    if (opts.signal?.aborted) return { text, ...(cursor ? { cursor } : {}) } // caller cancelled: do NOT reconnect
    await sleep(Math.min(1_000 * 2 ** attempt, 15_000), opts.signal)
  }

  return { text, ...(cursor ? { cursor } : {}) } // out of attempts; the cursor still resumes the same turn later
}
```

A non-2xx stream open uses the same HTTP error parser as other methods: `ZooworkError`
can carry `type`, `requestId` and diagnostic fields. Keep a status-only fallback for non-JSON
responses. When calling the public endpoint directly, use `?cursor=`: the public gateway
does not forward `Last-Event-ID`, so native EventSource header replay is not sufficient.
`?after=` selects the deprecated engine-only lane and omits echoed inputs; never put a unified
`seq` there.

---

## Reading history over REST

`listEvents(agentId, sessionId, opts?: { cursor?: string; types?: string[]; limit?: number })`
reads the same durable log the stream reads and returns the same normalized `SessionEvent[]`; text
assembled from a REST replay is identical to text assembled from the stream. But it returns
**one page** (`limit` defaults to 100 server-side, capped at 500) and drops the page's
`hasMore`/`nextCursor`. For the full log use `listAllEvents`; for hand-paging use
`listEventsPage`, which is the same call keeping the pagination fields:

```ts
const all = await zc.listAllEvents(agentId, sessionId)   // ascending seq, follows the cursor to the end
const page = await zc.listEventsPage(agentId, sessionId, { limit: 100 }) // { events, hasMore, nextCursor }
const userAndReplies = await zc.listAllEvents(agentId, sessionId, {
  types: ['user.message', 'agent.assistant'],            // a rendered message list in one filter
})
```

`listAllEvents` follows the server's `nextCursor` until `hasMore` is false (falling back to an
`after` walk on servers without cursor pagination). Both lanes stop when the cursor fails to
advance, so a misbehaving server costs one extra request instead of a spin. `types` is joined into
one comma-separated query parameter and filtered server-side; valid members are
`SESSION_EVENT_TYPES` plus `PUBLIC_INPUT_EVENT_TYPES`, anything else is `400 invalid_request`.
Passing `after` anywhere selects the deprecated engine-only lane (no echoed inputs); use it only
with a value stored from that lane, never with `event.seq`. `listAllEvents` also accepts
`{ cursor }` (TypeScript 0.13.0+, Python 0.8.0+) and starts the unified walk after it, without
falling back to `after`. Passing both `cursor` and `after` throws `TypeError` before any request.

### When the transcript is the better read

`getSession(agentId, sessionId, { history: true, limit })` returns the **at-rest transcript**, not
the event log: `history?: SessionHistoryEntry[]`, each `{ seq, entry_type, entry, created_at }`, the
most recent `limit` rows in ascending `seq`. The SDK forwards `limit` verbatim and pins no default
and no maximum for this surface, so pass one explicitly rather than assuming the `listEvents`
numbers apply here.

```ts
import { messageText } from '@zoowork-ai/sdk'

const s = await zc.getSession(agentId, sessionId, { history: true, limit: 50 })
const transcript = (s.history ?? [])
  .filter((row) => row.entry_type === 'message')       // other entry_types are anchors, compaction
  .map((row) => messageText(row.entry.message))        // entry.message is { role, content }, not payload
```

**The transcript has no cursor.** `limit` selects the most recent rows, and this surface takes no
`after` and no offset, so an older window of a long session is not reachable through it. That does
not matter for exports anymore: the event log is bidirectional, so
`listAllEvents(..., { types: ['user.message', 'agent.assistant'] })` is the complete two-sided
record of a session of any length. Reach for the transcript only for the two fields below.

Two things are easiest to read here:

- **Token usage.** `entry.message.usage` carries `input`, `output`, `cacheRead`, `cacheWrite` and
  `totalTokens`. The same block also rides on every `agent.assistant` event at
  `payload.message.usage`, so the transcript is the convenient read, not the only one. `usage.cost`
  is an **object** with those same keys, recorded as all zeros, so do not build a spend display on
  it.
- **The model that actually served the turn.** `entry.message.model` is what the agent is
  configured with; `responseModel` is what answered. They can differ when the deployment maps a
  model to a substitute, so trust `responseModel`. Both appear on the `agent.assistant` event
  payload too.

An assistant row also carries the provider's `stopReason` - and so does the `agent.assistant` event,
at `payload.message.stopReason`. It is a property of one message, not a turn signal: turn success
still comes only from `runOutcome`. Use the transcript to recover an answer whose events you missed
and the event log when you want the run; the transcript holds conversational messages, never
`run.started` / `agent.tool` / `run.finished`.

---

## Rendering

Every helper is a pure function over a `SessionEvent` that returns a harmless empty value for the
wrong event type, so you can call them all unconditionally in one loop.

| Helper | Returns | Empty value |
|---|---|---|
| `assistantText(e)` | Text of an `agent.assistant` event | `''` |
| `thinkingText(e)` | Reasoning text of an `agent.thinking` event | `''` |
| `toolCall(e)` | A `ToolCall` for an `agent.tool` event | `undefined` |
| `isRunFinished(e)` | `true` for `run.finished` | `false` |
| `runOutcome(e)` | `'succeeded' \| 'failed' \| 'aborted'` | `undefined` for any other event, and for an unrecognized status |
| `messageText(m)` | Text of a `{ role, content }` object | `''` |

`messageText` is the odd one: it takes a message, not an event, because it also serves transcript
rows where the message sits at `entry.message`. `content` is normally an array of blocks and only
`{ type: 'text', text }` blocks carry text - tool-use and thinking blocks do not - so reaching into
`content[0].text` yourself returns an empty string on many real messages. A plain string `content`
is accepted too; that is how write-side `user.message` content comes back.

```ts
interface ToolCall {
  phase: 'start' | 'end' | 'blocked'
  toolName: string
  toolCallId: string
  args?: Record<string, unknown>      // on start
  isError?: boolean                   // on end
  resultPreview?: string              // on end
}
```

Three rules, each of which is a bug someone has already shipped:

1. **Pair by `toolCallId`, not by adjacency.** One call produces multiple `agent.tool` events
   sharing a `toolCallId`. When calls run concurrently the `start` and `end` of one call are
   separated by events belonging to others, so a renderer that assumes the next `agent.tool` closes
   the previous one attributes results to the wrong tool. Keep a `Map<string, ToolCall>` keyed by
   `toolCallId` and delete on `end` or `blocked`.
2. **`blocked` is terminal, not pending.** The call ended without execution; no `end` follows.
   Reasons include policy denial, approval denial (`approval-denied`), approval timeout
   (`approval-timeout`), cancellation (`approval-cancelled`), or interruption (`interrupted`).
   Read `ev.payload.deniedReason`, remove the call from the pending map, and render its reason,
   not success. Approval waiting emits `agent.approval` / `requested`; `resolved` ends
   the wait, after which the tool/run outcome still needs observation.
3. **`isError` does not fail the run.** An `agent.tool` `end` with `isError: true` is routinely
   followed by `run.finished` with `status: 'succeeded'` - the model saw the tool error, worked
   around it, and answered. The inverse also holds: do not infer success from the absence of tool
   errors. Collect tool failures separately and report them *alongside* `runOutcome`, never instead
   of it.

`toolCall()` maps any phase it does not recognize onto `start`, so if you need the exact wire value,
read `ev.payload.phase`.

---

## Writing into a session

Exactly five event types can be posted. An invalid type or malformed body rejects with HTTP 400,
so handle a thrown error and use status when the exact code is unknown. A valid 202 response with
an `accepted: false` receipt is a different outcome. Source review shows input validation before
effects, but this is not a guarantee of transactional rollback for runtime batch failures.
Signature: `postEvents(agentId, sessionId, events: OutboundEvent[])` - the agent id comes first on
every session method, because the route is `/agents/{id}/sessions/{sid}/events`.

| Type | Body | Effect |
|---|---|---|
| `user.message` | `content` (non-empty **string**), optional `idempotency_key` (exercised - a same-key retry converges on the same event instead of double-delivering), optional `actor: { ref }` (exercised: a valid ref is accepted, a malformed one is a 400) and `attachments[]` (not exercised) | Appends a user turn and starts a run |
| `user.interrupt` | optional event-level `idempotency_key` | Aborts the in-flight run; that run ends `run.finished` with `status: 'aborted'` |
| `user.tool_confirmation` | `approval_id`, `decision`: `allow-once` / `allow-always` / `deny` | Resolves a pending approval |
| `user.custom_tool_result` | `custom_tool_use_id` or `call_id`, 1–16 result `content` blocks, optional `is_error`, stable `idempotency_key` | Resolves an application-executed custom call in the same run |
| `system.message` | `text` (non-empty string) | Injects a note the model reads on the **next** turn |

Source-reviewed actor rules: only `ref` is accepted inside `actor`, with 1–200 ASCII characters
matching `[A-Za-z0-9._:@+-]`. If actor is supplied, ref is required; token and unknown actor
properties are rejected. Omission falls back to the owner. Choose the ref from authenticated
backend state, not user-submitted JSON. It attributes API messages (including initial messages),
not authorization or file/session isolation. IM sessions reject caller-supplied actor.

```ts
const res = await zc.postEvents(agentId, sessionId, [
  { type: 'system.message', text: "Operator note: the user's plan is Enterprise." },
  { type: 'user.message', content: 'Which limits apply to me?', actor: { ref: 'customer-7' }, idempotency_key: 'msg-7' },
])
if (res.events[0]?.accepted !== true) { /* the event did not take - inspect before streaming */ }
```

`postEvents` answers `202` with one entry per submitted event. An accepted event comes back as the
full event object the history will show (with its `seq`); an unaccepted one stays a
`{ id, type, accepted: false }` receipt. `accepted` is the field that matters: `202` alone means
queued, not that a turn happened. Your accepted inputs then appear in the event log itself
(`user.message` and friends), with `processedAt` flipping from `null` to a timestamp once the agent
consumes them - so a UI renders the pending state and the final message list from the same surface.

`system.message` lands in context on the *following* turn, not the current one, so post it before
the `user.message` it should affect. It is the supported way to hand an agent state your application
owns, since there is no memory resource to write.

`user.interrupt` with **no** run in flight answers `accepted: false` at HTTP `202`. That is a no-op,
not an error - code that expects a thrown exception there has a cancel button that breaks whenever
the agent happens to have already finished.

`createSession(agentId, { initial_events })` has been exercised only with a single `user.message`,
and `user.message` is the only type the API reference says it takes there; the SDK's parameter type
(`OutboundEvent[]`) is wider than the route. Keep it to the opening message and post everything else
with `postEvents` once the create returns.

Production checks exercised approval resolution through REST and `user.tool_confirmation`,
including allow-once and deny. Waiting uses `agent.approval` / `requested`, not tool `blocked`.
The event payload uses `approvalId`; the outbound confirmation uses `approval_id`.
Read `references/not-supported.md` - Human approval signals for rendering and recovery.

---

## What not to build on: the delta preview lane

`chat.delta`, `chat.final`, `chat.aborted` and `chat.error` are members of the vocabulary but are
**not written to the durable event log**. They live on a separate, short-lived per-run preview lane
reached only by a query parameter that the SDK never sends, and `streamEvents` additionally drops
any frame it sees named `event_delta`. Everything the SDK yields is durable.

Porting streaming UI code, this is the trap: those preview frames carry `"replace": true`, meaning
**snapshot-replace** - each frame holds the current full text, not the newly added fragment.
Append-style delta logic that is correct against a prefix-append API produces text duplicated once
per frame here. Assign, never concatenate. Preview frames also carry no `id:` line, so they sit
outside the resume cursor entirely and never replay; a reconnect re-derives them from the next
`run.started`.

The lane is unverified against a live deployment, may answer `501 not_configured`, and is not part
of the durable contract. Build finished text from `agent.assistant` events through `assistantText`,
which is durable, resumable and verified - and if a caller genuinely needs token-level streaming,
say that this API does not offer it in a supported form rather than shipping the delta lane.

For the full method list and return shapes, read `references/typescript-sdk.md` - Events.

## Subsequent turns and recovery without a cursor

For serial turns, save the last processed `ev.cursor` with the Session ID before sending the
next message, then call `streamEvents(agentId, sessionId, { cursor: savedCursor })`.
Never fall back to no cursor for an existing conversation and stop at the first `run.finished`:
that is the old first turn, not the new answer. Correlate runs when multiple runs can overlap.

REST event objects and `postEvents` receipts have no cursor. The last REST page's nextCursor
is null. There is no current-tail helper; do not derive a cursor from seq or use the legacy
`after` lane. If the checkpoint was lost, replay and reconstruct state using recorded inputs
and runs, or explicitly start a new conversation. A new Session does not retain the old context.

A retained, verified `run.finished` webhook can contain `data.event_cursor`. Use it as a
checkpoint only after processing the corresponding turn: resuming after it skips prior output.
This is a delivered event correlation, not a query for the current tail.
