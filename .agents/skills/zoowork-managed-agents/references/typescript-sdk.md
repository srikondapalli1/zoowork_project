# TypeScript SDK surface

Client methods are grouped below. The installed package's `dist/index.d.ts` is the authority
for signatures, not deployment availability. Apply the production restrictions below first. Read `developer-api.md` for text task inputs, file outputs, Database, Usage, Organization balance, Run Output,
action paging and signed webhook helpers, including release checks and HTTP fallback.
From 0.14.0 the package requires Node.js 22 or later (`engines.node` is `>=22`).

## Client construction

```ts
createZooworkClient(cfg: ZooworkConfig = {}): ZooworkClient   // cfg itself is optional

interface ZooworkConfig {
  apiKey?: string    // falls back to ZOOWORK_API_KEY; an empty ENV VAR counts as unset, an explicit apiKey: '' does not
  baseUrl?: string   // falls back to ZOOWORK_BASE_URL, then DEFAULT_BASE_URL (production) - leave unset unless pointing at a different deployment; trailing slashes stripped
  auth?: ZooworkAuth // advanced existing client configuration; prefer apiKey
  fetch?: (input: string, init?: RequestInit) => Promise<Response>  // for edge runtimes and tests
}

export type ZooworkAuth = { serviceToken: string } | { apiKey: string }
export const DEFAULT_BASE_URL = 'https://clawapi.ecap.gsmo.ai/service/v1'
```

Client configuration reads `ZOOWORK_API_KEY` and `ZOOWORK_BASE_URL`. Webhook verification also
reads `ZOOWORK_WEBHOOK_SECRET`. There is no `ZOOWORK_ORG_ID`: the gateway derives the
tenant from the key, so an org id in your environment is dead configuration. Construction **throws a
plain `Error`, not a `ZooworkError`**, when no key resolves - a missing key is a setup mistake, and
failing loudly here beats a 401 on whatever call runs first, but it does mean a `catch` narrowing on
`instanceof ZooworkError` will not match it. That guard tests `cfg.apiKey !== undefined`, not
truthiness, so an explicit `apiKey: ''` - which is what `process.env.KEY ?? ''` hands you - slips
past it and builds a client that sends an empty bearer and 401s on the first call. Only the
environment-variable path maps `''` to unset. `DEFAULT_BASE_URL` already includes the `/service/v1`
version prefix; appending another `/v1` 404s every call. An `Idempotency-Key` header is sent only
when the optional key argument is truthy for core creates. Webhook create, rotation, test
and redelivery require a stable explicit key.
Sending a header is not an exactly-once guarantee. Source-reviewed creation contracts use HTTP
keys for Agent and Session; schedules converge on stable IDs and identical definitions;
Skill uploads carry the key but do not guarantee replay; see [Skill registry](./skill-registry.md).
A key replays the first response for at least 7 days on `createAgent` and at least 24 hours on
`createSession`, webhook writes and other keyed writes; after that the same key runs as a new
request, so a create retried that late makes a second Agent or Session.
`postEvents` uses an `idempotency_key` inside each event body instead.

## Models

```ts
listModels(): Promise<ModelInfo[]>   // no arguments, no paging
```

Model ids are prefixed, e.g. `litellm/gpt-5.6-terra`. Both wire shapes (a bare array or
`{ models }`) are tolerated, so you always get an array. `ModelInfo.api` can be
`anthropic-messages`, `openai-completions`, `openai-responses`, or a future string; preserve
unknown values. Omitting `AgentResource.model` pins the server defaults current at create time.
The current source default is Terra, but deployments can differ and the default can rotate;
select a returned alias explicitly for repeatable provisioning. A catalog row can remain visible
for an existing Agent while `selectable` is false. Filter with `row.selectable !== false` before a
new create or update; otherwise the service answers `409 model_not_selectable`. Lifecycle fields
include `expired_at`, `expired_fallback_to`, `retired_at`, `revision`, `lifecycle_status`,
`retire_not_before`, and `default_for`. Refresh the catalog and prefer the replacement alias when
one is supplied. `default_for` names configuration slots such as `model`, `imageModel`,
`imageGenerationModel` and `pdfModel`, not input modalities; do not filter it by `text`. For the
primary chat default, select the selectable row whose `default_for` includes `model`. The catalog
is not ordered by preference, so do not take its first selectable row.

Read [Thinking levels](./thinking-levels.md) for `ModelInfo.thinking`, the five-level enum,
clamping, platform defaults, and the distinct Agent/Schedule clear semantics.

## Agents

A stored, versioned configuration. Create once, keep the `agent_id`, reference by id forever.

```ts
createAgent(input: { resource: AgentResource; ownership?: Ownership }, idempotencyKey?: string): Promise<AgentRecord>
listAgents(opts?: AgentListParams): AgentPagePromise
getAgent(agentId: string): Promise<AgentRecord>
updateAgent(agentId: string, sections: Record<string, unknown>): Promise<AgentRecord>  // per-section PUT; ownership-only changes do not bump config_version; optional expected_config_version gives atomic CAS
deleteAgent(agentId: string): Promise<void>                     // first success 204, repeat 404; does NOT remove the agent's schedules - delete those yourself first
startAgent(agentId: string): Promise<{ warnings: string[] }>    // successful warnings are informational; non-2xx still throws
stopAgent(agentId: string): Promise<{ warnings: string[] }>     // does not clear environment_locked, does not remove schedules
waitUntilRunning(agentId: string, opts?: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal }): Promise<AgentRecord>
```

`ownership` can be omitted - the gateway derives your key's tenant on its own. **The create
receipt and the read projection are different documents under one `AgentRecord` type:**

| | `createAgent` (receipt) | `getAgent` / `updateAgent` (projection) |
|---|---|---|
| Config version | top-level `config_version` | `status.config_version` |
| Configuration | absent | `declared` |
| Lifecycle | absent | `status.desired_state`, `status.actual_state` |

Read the version across both as `agent.status?.config_version ?? agent.config_version`. One alone is
`undefined` on the other path, and `undefined === undefined` makes a "nothing changed" check pass
when it should not. Pass the positive version as top-level `expected_config_version` in
`updateAgent` sections for an atomic check-and-write. A mismatch returns
`409 active_config_changed` and changes nothing. Re-read the Agent and recompute the intended
change before retrying; do not just put a fresh version on a stale body. The precondition is
not stored in `declared`. Omit it for last-write-wins updates. Configuration writes can
increment the version even with identical values, while ownership-only changes do not.
Read your declared section to reconcile uncertain writes. This optional Agent PUT precondition
is separate from the required `upgradeSystemPrompt` precondition (`409 config_version_changed`).

**`updateAgent` merges per section.** `sections` is the declared config keyed by section, so sending
only `model` leaves `persona`, `labels`, `mcp` and the rest untouched. Plain-object sections shallow-merge one level: updating
`labels: { tier: 'paid' }` keeps an existing `labels.region`. Nested objects, arrays and scalars
replace their values, so sending `persona.docs` replaces that whole array. `tool_policy` and
`system_prompt` replace their entire sections. The labels merge and whole-section `tool_policy` replacement were verified in production. All of `AgentResource` is
optional except `name: string`:

| Field | Type | Note |
|---|---|---|
| `userTimezone` | `string` | named IANA timezone used in prompt context and message timestamps; it does not set Schedule timezone |
| `model` | `{ primary: string; input?: string[]; max_tokens?: number; thinking?: ThinkingLevel \| null }` | prefixed id from `listModels()`; `max_tokens` caps output per model request (omit for the platform default) |
| `persona` | `{ docs: { name: string; content: string; seed_policy?: string }[] }` | `docs` is an **array of documents**, not a filename-keyed object |
| `skills` | `{ skill_id: string; version?: number \| 'latest' }[]` | explicit installs; each stays on the version resolved at create, even `'latest'`; an empty array at create opts out of automatic global Skills; do not add `name` (it makes the list the exact Skill set and later assignments return 409) |
| `include_global_skills` | `boolean` | defaults true; false disables automatic global Skills without removing explicit installs, and persists across updates and rerenders |
| `labels` | `Record<string, string>` | what `listAgents({ labels })` filters on |
| `tool_policy` | `Record<string, unknown>` | exact-name `allow`/`deny` verified in production; matching also accepts global `*` or one trailing `prefix*` (source-reviewed); `alsoAllow` remains exact-only |
| `mcp` | `McpServerDeclaration[]` | remote HTTP only; supports exposure, opt-in runtime context, server permission defaults, and exact per-tool overrides |
| `custom_tools` | `CustomToolDeclaration[]` | up to 32 application-executed tools: `name`, `description`, object `input_schema`, optional `timeoutMs` |
| `sandbox` | `{ scope: 'agent' \| 'session' }` | `exec` needs `agent` |
| `environment_id`, `environment_version` | `string`, `number` | pins permanently on first sandbox creation |

`McpServerDeclaration.exposure` is either `deferred` (also the omission default) or `direct`;
there is no `auto`. Deferred tools load through `tool_search` / `tool_describe` and remain
available on later turns in the same Session. Direct tools are declared on the first model
request. Both modes were exercised in production.

Source-reviewed MCP additions:

```ts
interface McpServerDeclaration {
  name: string
  url: string
  transport?: 'streamable-http' | 'sse'
  credential?: string
  toolFilter?: string[]
  exposure?: 'deferred' | 'direct'
  context?: { meta?: boolean; headers?: boolean }
  permission?: 'always_ask' | 'always_allow'
  tools?: Record<string, { permission: 'always_ask' | 'always_allow' }>
  [k: string]: unknown
}
```

Both context switches default to false. `meta` adds `_meta["ai.zooclaw/context"]`; `headers`
adds `x-zooclaw-*` headers during tool execution. The payload contains agent/session/computer ids
and optional run/turn/config/actor fields. Catalog discovery carries no runtime context, and HTTP
intermediaries may strip custom headers. These identifiers are context, not authentication.

`permission` is the server default. `tools` overrides exact native MCP tool names before the
`mcp__<server>__<tool>` prefix is added, accepts no wildcard keys, and is capped at 64 entries.
Omission preserves the default-allow behavior. An allow-always decision on a server wildcard
covers every tool from that server for the Session; use exact overrides when that scope is too
broad. Production checks exercised MCP approval with allow-once and deny.

Tool-policy matching uses exact names, global `*`, or one trailing `prefix*` in allow, deny, rule
match/afterRules and deferred MCP pinned entries. Other star placements match nothing.
`alsoAllow` is exact-only, and the first matching rule wins.

The onboarding interview is always skipped: the SDK sends `onboarding: false` on every create, so
the agent answers your first message directly. Ownership is likewise handled for you - the gateway
derives it from your API key, and `createAgent`'s `ownership` input is only for gateway-less
engine access.

`listAgents` applies the key's Project and applicable owner visibility. Reading by ID also
rechecks authorization; a colleague's Agent is not automatically accessible. Treat foreign and
unknown IDs returning 404 identically.

**Agent list pagination is version-sensitive.** Check the installed SDK's declarations before
using this shape. The implementation in [SDK PR #26](https://github.com/SerendipityOneInc/zoowork-sdk-typescript/pull/26)
returns `AgentPagePromise`; SDK 0.5.2 returns `Promise<AgentRecord[]>` instead. Use a package
release containing the pagination change for the following examples. The page object and
`for await` iteration were exercised in production on a single page; multi-page continuation is
source-reviewed and offline-tested.

```ts
interface AgentListParams {
  labels?: Record<string, string>
  page?: number
}
interface AgentPage extends AsyncIterable<AgentRecord> {
  readonly data: AgentRecord[]
  readonly page: number
  readonly page_size: number
  readonly total: number
  readonly next_page: number | null
  hasNextPage(): boolean
  getNextPage(): Promise<AgentPage>
  iterPages(): AsyncIterableIterator<AgentPage>
}
interface AgentPagePromise extends Promise<AgentPage>, AsyncIterable<AgentRecord> {}
```

```ts
// All matches: the SDK fetches each next page only when iteration reaches it.
for await (const agent of zc.listAgents({ labels: { app: 'support' } })) {
  console.log(agent.agent_id)
}

// One page: await, then read .data rather than treating the result as an array.
const page = await zc.listAgents()
console.log(page.data, page.total, page.next_page)
if (page.hasNextPage()) {
  const next = await page.getNextPage()
  console.log(next.data)
}
```

`next_page` is a numeric page starting at 1, derived from `page`, `page_size`, and `total`;
it is `null` at the end. Do not invent `limit` or a string cursor: the API fixes page size
at 100. `getNextPage()` preserves the original label filters, and rejects on the last page.
Breaking async iteration stops further requests; failed later requests and invalid pagination
metadata throw rather than silently yielding an incomplete result. `page.iterPages()` walks
page objects. Concurrent additions/deletions can shift results; this is not snapshot pagination.

When migrating an array caller, use `const { data: agents } = await zc.listAgents(opts)` for
one page, or `for await` for all matches. Do not apply `.data` or async iteration to the
0.5.2 array-return method.

**`waitUntilRunning`** defaults to `timeoutMs = 30_000`, `intervalMs = 500`, polls `getAgent`, and
returns that `AgentRecord` once `status.desired_state === 'running'`. Both failures are
**synthesized locally - the server never sends either**, which matters to any retry policy that
treats server 408s specially: a spent budget throws `408` with `type: 'timeout'`, an aborted
`signal` throws `0` with `type: 'aborted'`. Both bounds cover an in-flight poll, not just the gap
between polls, which is why this beats a hand-rolled loop - `fetch` imposes no timeout of its own in
any runtime the SDK targets, so a stalled gateway parks such a loop forever. The other reason is
`actual_state`: it is not API readiness. It is derived from `desired_state` and reads `active`,
`stopped` or `deleting`; it reflects neither channel health nor whether a turn can run.
`status.channels` (`expected`, `connected`, `degraded_since`) holds fixed placeholder values
(`0`, `0`, `null`), not observed channel counts. `running` is not one of its values. `status` can
also carry optional `agent_desired_state` and `computer_desired_state`: the Agent's own switch
and its sandbox runtime's switch. `desired_state` is `running` only when both are.

Successful start/stop responses may contain warnings, but HTTP and transport failures still throw.
Source-reviewed stop behavior can write desired state before a later step fails: read `getAgent`
after an uncertain failure and reconcile. Soft deletion is not resource cleanup.

### Thinking types and partial model updates

```ts
type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max'
type AgentModelUpdate = Partial<NonNullable<AgentResource['model']>>
type AgentUpdate = { model?: AgentModelUpdate; [section: string]: unknown }
```

Use `satisfies AgentUpdate` to check a partial `model.thinking` update. `updateAgent` itself
continues to take `Record<string, unknown>`. `ModelInfo.thinking` is optionally
`{ default: ThinkingLevel; levels: ThinkingLevel[] }`. `SchedulePayload.thinking` is
`ThinkingLevel | null`. Exact examples and compatibility rules are in
[Thinking levels](./thinking-levels.md).

## Channels

A channel connects a chat account to an Agent; messages to that account start Sessions on the
Agent, and those Sessions are readable with the same key. Each Agent has one connection per
platform. Omit `account` (or pass `'default'`) on every call: with a Project key any other name
answers `400 channel.account_invalid`, and responses report the connection as `'default'`.

QR platforms are `feishu`, `wecom` and `weixin`. WeChat has no other path: `addChannel` with
`'weixin'` answers `400 channel.weixin_setup_required`.

```ts
const setup = await zc.startChannelSetup(agentId, 'weixin', { dm_policy: 'open' })
const qr = setup.verification_uri_complete ?? setup.qrcode_url // render this for the account owner
const result = await zc.waitForChannelSetup(agentId, 'weixin', setup.session_id, {
  timeoutMs: setup.expires_in * 1000, // default is 600s; WeCom and WeChat expire after 300s
})
if (result.status !== 'success') throw new Error(`setup ended: ${result.status}`)
```

- The binding is written by the poll that observes the confirmation, so keep polling while the
  person scans. `waitForChannelSetup` returns `success` / `expired` / `denied` / `error`; a
  cancelled session answers `404 channel.{platform}_session_not_found`.
- Feishu and WeCom setup on an Agent that already has that platform answers `409 channel.conflict`
  before a QR is issued: `removeChannel` first. Scanning WeChat again for the same Agent replaces
  its connection; one WeChat account holds one connection, so scanning it for a second Agent
  disconnects the first.
- `addChannel` takes app credentials in camelCase `config`: Slack `{ botToken, appToken }`,
  WeCom `{ botId, secret }`, Feishu `{ appId, appSecret, domain }`. DingTalk uses
  `platform: 'dingtalk-connector'` with `{ clientId, clientSecret }`; that route is in the SDK
  source but no live request has exercised it, so verify it on your deployment first.
- `dm_policy: 'allowlist'` with `allow_from` sender IDs limits who can message the Agent
  directly; other policies ignore `allow_from`, and DingTalk needs explicit IDs (no `'*'`). It is
  a chat-side filter, not authorization for your API: channel conversations stay readable as
  Sessions with the key.
- Feishu document permission administration: pass `permission_admin_enabled: true` to
  `addChannel` or `startChannelSetup` (other platforms answer
  `400 channel.permission_admin_not_supported`). Readiness is `capabilities.feishu_documents` on
  `listChannels`: `sync.state` reaches `'applied'` and `provider.state` is `'ready'` with empty
  `missing_scopes`; `approval_state: 'pending_admin'` means a workspace admin must approve. These
  capability fields are source-reviewed in the SDK types, not live-verified.
- `201` means stored, not working: credentials are checked when the connection starts. Read
  `health` / `status` from `listChannels`. Same `platform` with different `config` answers
  `409 channel.conflict`; rotate credentials by removing and adding.
- `removeChannel` succeeds when nothing is bound; deleting the Agent removes its connections.
  Channel health is never in the Agent's `status`.

## Sessions

One conversation. Every session method takes `agentId` first, because the route is
`/agents/{id}/sessions/...` and there is no session handle that hides it.

```ts
createSession(
  agentId: string,
  input: { initial_events?: OutboundEvent[]; metadata?: Record<string, unknown>; runtime_mode?: 'active'; idle_compaction?: boolean | null },  // input is required, both fields optional
                                                                                    // initial_events: only ONE user.message has been sent here - the type is wider than what is verified
  idempotencyKey?: string,
): Promise<SessionRecord>                                                          // 409 agent_not_running unless desired_state is running
getSession(agentId: string, sessionId: string, opts?: { history?: boolean; limit?: number }): Promise<SessionRecord>
listSessions(agentId: string, opts?: { page?: number }): Promise<SessionRecord[]>  // newest first, 50 per page, 1-based, no cursor
listSessionPage(agentId: string, opts?: SessionListPageOptions): Promise<SessionListPage> // filtered cursor lane; initial sls1:0
archiveSession(agentId: string, sessionId: string): Promise<{ session_id?: string; archived: boolean }>
deleteSession(agentId: string, sessionId: string): Promise<void>   // soft delete; cancels an in-flight run, keeps the transcript
```

**There is no `patchSession`, on purpose.** `PATCH` is not proxied by the gateway at all (its
catch-all registers GET/POST/PUT/DELETE), so it answers 405. Session `metadata` is write-once, at
`createSession`; mutable per-conversation state belongs in your own store keyed by `session_id`. The
run outcome is `run_status` (`null` before the first run), and it is on **both** surfaces - `listSessions` rows and `getSession`
alike, so a read already has it and needs no second call. The decoy is `status`: `null` on
`getSession`, absent from list rows entirely, and carrying `running` only on the `createSession`
receipt. Asking for `history: true` populates `history?: SessionHistoryEntry[]`, the at-rest
transcript rather than the event log - text is at `entry.message` (`{ role, content }`) on rows
whose `entry_type` is
`message`. `archiveSession` flips `archived` to `true` (the receipt is `{ session_id, archived }`,
and a later read still answers `archived: true`); afterwards writes answer `409 session_archived`
while reads keep working, so interrupt an in-flight run first or the archive races it.

`pending_approvals?: number` and `pending_custom_tool_calls?: number` are counts, not record
arrays (observed in production). Use `listApprovals` or `listCustomToolCalls` for records. Filtered cursor rows can
also carry `runtime_mode`, `config_version`, `last_activity_at`, and opaque `list_cursor`.

`listSessionPage` supports `limit` 1–100, `excludeChannels`, `includeSurfaces`, `runtimeModes`, and
`includeArchived`. `includeDeleted: true` adds deleted Session tombstones, whose rows carry
`deleted: true`; the page then carries `includes_deleted: true`. Omit `cursor` to start; the SDK
sends `sls1:0`. Continue with `next_cursor`, keep filters including `includeDeleted` identical,
and never parse a cursor: it is bound to the Agent and filter scope. Invalid reuse returns
`400 invalid_cursor`. Tombstones are reconciliation records, not readable Session resources.
Cursor walking, `runtimeModes` and `includeDeleted` tombstones were verified in production.
Sessions created through the API have `channel: 'api'`, so `excludeChannels: ['api']` omits all
of them; pass it only when you intend to list non-API Sessions.

## Events

`references/events-and-streaming.md` - Reading a turn covers the helpers and the reconnect loop.

```ts
postEvents(agentId: string, sessionId: string, events: OutboundEvent[]): Promise<{ events: PostEventReceipt[] }>
listEvents(agentId: string, sessionId: string, opts?: { cursor?: string; types?: string[]; limit?: number }): Promise<SessionEvent[]>
listEventsPage(agentId: string, sessionId: string, opts?: { cursor?: string; types?: string[]; limit?: number }): Promise<SessionEventPage>
listAllEvents(
  agentId: string,
  sessionId: string,
  opts?: { cursor?: string; types?: string[]; pageSize?: number },
): Promise<SessionEvent[]>
streamEvents(agentId: string, sessionId: string, opts?: { cursor?: string; signal?: AbortSignal }): AsyncGenerator<SessionEvent>  // a generator, not a promise
// Each method also has a deprecated overload taking `after?: number` instead of `cursor`. `after`
// selects the engine-only lane, never a unified `seq`. Both together do not type-check; at runtime
// `listAllEvents` throws `TypeError` and the server answers the others with 400 invalid_request.
```

Only five `OutboundEvent` types can be written: `user.message`, `user.interrupt`,
`user.tool_confirmation`, `user.custom_tool_result`, `system.message` - and all five echo back into the event log, so the log
alone renders the whole conversation. `postEvents` answers 202; an accepted event comes back as the
full event object (with its `seq`), and a `user.interrupt` with no run in flight comes back
`accepted: false`, a normal reply rather than an error. Give each event an `idempotency_key` so a
timeout retry converges instead of double-delivering. **`listEvents` returns one page and drops the
page's pagination fields.** `limit` defaults to 100 and caps at 500. `listEventsPage` is the same
call keeping `hasMore`/`nextCursor` (`SessionEventPage` is `{ events, hasMore?, nextCursor? }`) -
feed `nextCursor` back as `cursor` to page by hand. `listAllEvents` follows the server's cursor to
the end of the log, falling back to an `after` walk on servers without cursor pagination; both
lanes stop when the cursor fails to advance, and results are ascending by `seq`, deduplicated
across page boundaries. Passing `after` anywhere selects the deprecated engine-only lane (no echoed
inputs); use it only with a value stored from that lane, never with `event.seq`. From 0.13.0
`listAllEvents` accepts `{ cursor }` and starts the unified walk after it.

`streamEvents` opens exactly one request and yields until the body ends. It does **not** reconnect,
retry or back off; when the server closes on idle the generator returns, and resuming is your loop
calling it again with `{ cursor }` from the last event's `cursor` token. A non-2xx response throws
a `ZooworkError` parsed by the shared HTTP parser, with optional `type` and diagnostics; an abort via `opts.signal` ends the generator cleanly rather than
throwing.

## Application-executed custom tools

```ts
listCustomToolCalls(agentId: string, opts?: { status?: 'pending' }): Promise<CustomToolCallRecord[]>
resolveCustomToolCall(
  agentId: string,
  callId: string,
  input: { content: CustomToolResultContent[]; isError?: boolean; resolvedBy?: string },
): Promise<CustomToolCallRecord>
```

`CustomToolDeclaration` has required `name`, `description`, and object `input_schema`, plus optional
`timeoutMs`. The declaration name is 1–64 ASCII letters, numbers, `_` or `-`; descriptions cap at
4 KiB, schemas at 16 KiB, declarations at 32, and timeout at 86,400,000 ms (default 600,000).

`agent.custom_tool_use` has `requested` and `resolved` phases. Use `customToolUse(event)` for the
normalized `callId`, `toolCallId`, name, input, timeout, outcome, and resolution fields. Resolve
with 1–16 text, JSON, or base64 image content blocks. The equivalent write event is
`user.custom_tool_result`, using `custom_tool_use_id` or the accepted `call_id` alias, optional
`is_error`, and a stable `idempotency_key`.

`listCustomToolCalls` only accepts a missing status or `pending`. A pending resolution returns 202
and may carry `signaled: true` while remaining pending until the run consumes it; already terminal
calls return 200 and `signaled: false`. Production checks verified the lifecycle, `404 not_found`
for an unknown call, and `400 invalid_request` for a name that shadows a built-in tool. The 403
wrong-Agent, 409 stopped-workflow and 501 unavailable-signaling cases are source-reviewed.

## Skills

Use `listAgentSkills(agentId)` to inspect resolved attached Skills. `resource.skills` accepts
`{ name: 'catalog-skill' }` or `{ skill_id: 'skl_...' }`, optionally with a version. Automatic
global Skills are enabled unless explicitly opted out.

See [Skill registry](./skill-registry.md) for the source-reviewed Project-key upload contract:
named Project keys write `project` scope; Default Project keys write `org` scope. Check the
deployment separately. Older SDK declarations restrict `uploadSkill` to `org | personal`;
use `uploadSkill(zip, { scope: 'project' })` only when the installed declaration accepts it.
Otherwise use the documented multipart HTTP request. Do not substitute `personal` or suppress the type error.
Workspace file writes do not register a Skill.

## Exec and wake

```ts
exec(agentId: string, args: string[]): Promise<ExecResult>   // args is argv, NOT a shell string
wake(agentId: string, input: { text: string; mode?: 'now' | 'next-heartbeat'; deliverToUser?: boolean }): Promise<WakeResult>

interface ExecResult { exit_code: number; stdout: string; stderr: string }   // non-zero exit is still HTTP 200
interface WakeResult { mode: 'now' | 'next-heartbeat' | string; queued: boolean; triggered: boolean }
```

`uploadFile(agentId, path, content)` copies bytes or a string into `/workspace` through `exec`
and resolves to `{ path, size, sha256 }`. A project pinned below the baseline lacks it; follow
the `exec` upload in `developer-api.md` there.

`exec(id, ['ls /workspace'])` looks for a binary literally named `ls /workspace`; for shell
semantics pass `['bash', '-lc', 'ls /workspace']`. **A non-zero exit is still HTTP 200** - the
promise resolves and you check `exit_code` yourself; it rejects when the call fails, not when the
command does. `cwd` is fixed to `/workspace` with no option to change it, so use absolute paths or
`cd` inside a `bash -lc` string. It requires an agent-scope sandbox and a rendered config: a
session-scope agent answers `409 exec_requires_agent_scope`, an unrendered one
`409 exec_config_not_ready`, a deployment with no sandbox backend `501 not_configured`. Default
timeout 300s; `stdout` and `stderr` are each capped at 200,000 characters. `wake` pushes a reminder
into the heartbeat queue. `next-heartbeat`, the default, only writes the pending row - nothing
consumes it unless the agent has a heartbeat configured, so on an agent without one it succeeds and
does nothing. `now` writes the row and kicks the heartbeat schedule, and is 409 when no heartbeat is
enabled; if the heartbeat is busy the kick is skipped and the row waits for the next one.
`deliverToUser: false` keeps the reminder internal to the agent's reasoning.

## Schedules

For a Schedule's reasoning override, use `payload.thinking` on `agentTurn`. Its `null` value
clears the override and follows the Agent again. Read [Thinking levels](./thinking-levels.md)
for allowed values, legacy normalization and effective-level checks.

Cron-driven turns, where the read shape and the write shape are different documents.

```ts
listSchedules(agentId: string): Promise<ScheduleRecord[]>              // no opts, no paging
createSchedule(agentId: string, input: ScheduleInput, idempotencyKey?: string): Promise<ScheduleRecord>
getSchedule(agentId: string, scheduleId: string): Promise<ScheduleRecord>   // the SHORT id you chose, not record.scheduleId
updateSchedule(agentId: string, scheduleId: string, update: ScheduleUpdate): Promise<ScheduleRecord>
deleteSchedule(agentId: string, scheduleId: string): Promise<void>
triggerSchedule(agentId: string, scheduleId: string): Promise<{ schedule_name?: string; triggered: boolean }>
listScheduleRuns(agentId: string, scheduleId: string, opts?: { limit?: number }): Promise<ScheduleRun[]>  // rows GROUPED BY source, not time-sorted; limit defaults 20, caps at 100
```

**Which id to pass.** Use the public `schedule_id` on create and read projections.
Compatibility fields can include `name`, `memo.schedule_id` and a fully qualified `scheduleId`;
do not pass a fully qualified path as the public id. Read the saved cadence from
`scheduleSpec.cronExpressions[0]`, and preserve optional `session_id`, `run_id`, `linked_by`
and trigger attribution when present. These fields do not prove a turn succeeded.

**A `getSchedule` result is not a legal PUT body.** `updateSchedule` discards six fields before
sending, and all six are fields a read hands you:

| Field | What the server does with it |
|---|---|
| `execution`, `originMetadata`, `contextSnapshot`, `creatorPrincipalRef` | 400, server-derived |
| `sessionTarget` | 400, immutable |
| `scheduleSpec` | **200, then silently ignored** |

All six are typed `never` in `ScheduleUpdate` so TypeScript refuses them, and the SDK strips them at
runtime so the same read-tweak-write round trip works from JavaScript too. The last row is the
expensive one: `scheduleSpec` is the only place a read puts the cadence, so echoing it back answers
200 while leaving the old cron expression in place, and every sibling field in the body applies -
the update looks like it worked. **To change the cadence send `schedule`, the input vocabulary.**
`ScheduleSpec` has three kinds (`cron`, `every`, `at`). Interval input is
`{ kind: 'every', everyMs: 60_000 }`, with optional `anchorMs` (epoch milliseconds); an enabled
60-second interval fired automatically in production checks. The old `every` field is not the
wire contract: migrate explicitly rather than guessing units. Cron is five fields; macros and a `CRON_TZ=` prefix are rejected, and overlap
is fixed to skip server-side, so a fire landing on a still-running one is dropped, not queued.

`createSchedule` is 409 when you re-create an existing `schedule_id` with a **different**
definition; an identical retry is accepted. PUT and DELETE carry no cross-timeout idempotency
guarantee - after a timeout, reconcile by listing and reading runs rather than blind-retrying.
**Schedules outlive their agent**: neither `stopAgent` nor `deleteAgent` removes them, so delete
them yourself first. While the Agent is stopped or deleted, each fire is skipped with reason
`runtime_stopped` instead of running a turn. `triggerSchedule` returns
`triggered: true` even for a **disabled** schedule, which is then skipped. Manual execution
requires `enabled: true`; enabling also activates automatic firings. The receipt means a
request was accepted, not that work ran. Read `listScheduleRuns` and follow schedule webhooks;
skipped rows can lack `status` and `session_id`, so do not infer success from missing fields. Those rows mix two shapes discriminated by `source`: `temporal` rows are
dispatch records (`scheduled_at` / `taken_at` / `workflow_id` / `temporal_run_id`) saying nothing
about the outcome, `run_projection` rows are outcome records (`fired_at` / `status` /
`consecutive_errors`). On an enabled schedule, production fires produced rows with `session_id`
and `linked_by: 'dispatch_id'`. It is optional, not guaranteed for skipped, dispatch or command runs. Follow it when present; otherwise inspect sessions
with `channel: 'cron'` and the relevant schedule prefix. Do not manufacture an association.

**A cron job can carry an outcome gate.** `payload.outcome` on `ScheduleInput` (and the agent-level
default at `resource.outcome`) says what "done" looks like:

```ts
payload: {
  kind: 'agentTurn',
  message: 'Generate the weekly report.',
  outcome: {
    description: 'A non-empty report exists at /workspace/report.md.',
    evaluator: { type: 'command', command: 'test -s /workspace/report.md' },  // or { type: 'rubric', rubric: { type: 'text', text: '...' } }
    maxIterations: 3,              // 1-5
    publish: 'after_satisfied',    // | 'always' | 'never'
  },
}
```

The run evaluates, revises, and finalizes inside itself, and under the default policy nothing that
failed evaluation is announced. Stored verbatim - no defaults are injected into the stored copy,
and an unknown key anywhere inside `outcome` is a 400 naming the field, so a typo cannot silently
drop a limit. Job-level `outcome` overrides the agent default; an explicit `null` opts the job out.
Cron fires only: heartbeats and interactive sessions never evaluate. A rubric outcome on an
enabled, manually triggered schedule produced an `outcome.evaluated` webhook with
`verdict: 'satisfied'` in production checks; the command evaluator is source-reviewed.

## Approvals

```ts
listApprovals(agentId: string, opts?: { status?: 'pending' }): Promise<ApprovalRecord[]>  // 'pending' or omitted; any other value is rejected
resolveApproval(
  agentId: string,
  approvalId: string,
  input: { decision: ApprovalDecision; resolvedBy?: string },
): Promise<ApprovalRecord>

export type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny'
```

Because `status` may only be omitted or `'pending'`, resolved approvals cannot be listed - record
decisions yourself if you need an audit trail. Where no approval signaler is configured the route
answers `501 not_configured`, a deployment property your code cannot fix. Two shapes describe the
same approval flow: this REST resource and the `user.tool_confirmation` event you write
with `postEvents`. Use the approval ID to resolve a decision and `tool_call_id` to associate its
tool UI; the two IDs are not interchangeable. Production checks exercised REST and event
confirmation with allow-once and deny.
Observed pending records carry `approval_id`, `session_id`, `run_id`, `tool_call_id`,
`tool_name`, `arguments_preview`, `status`, `requested_at`, `timeout_at` and `allowed_decisions`.
`resolved_by`, `resolved_at`, `decision` and `signaled` are source-reviewed resolution fields;
`created_at` is kept only for legacy compatibility. Optional fields can be absent.
A 202 resolve with `signaled: true` can still have `status: 'pending'`: this acknowledges
signaling, not action completion. Observe the later tool/run outcome and authorize the reviewer
in your own application; see `references/not-supported.md` - Human approval signals.

## System prompt

```ts
getSystemPrompt(agentId: string): Promise<SystemPromptInfo>
previewSystemPrompt(agentId: string, input: SystemPromptPreviewInput): Promise<SystemPromptPreview>
upgradeSystemPrompt(
  agentId: string,
  input: { expected_config_version: number; template_version?: number },
): Promise<SystemPromptUpgrade>

export type SystemPromptDeclaration =
  | { source: 'platform'; version: number }
  | { source: 'custom'; base_version: number; template: string }
```

A fresh create pins the platform template version active at that moment - the declaration reads
back as `{ source: 'platform', version: N }` - and the pin **never follows a later platform
activation on its own**: ordinary PUTs, skill changes and rerenders keep it. Moving it is
exactly one call, `upgradeSystemPrompt`: `expected_config_version` is a required CAS (stale
answers `409 config_version_changed` - read the projection fresh, then upgrade), omitting
`template_version` upgrades to the currently active platform version, and the 200 receipt
carries the NEW `config_version` because an upgrade is a config write like any other. On PUT
the `system_prompt` section is replace-on-write, like
`tool_policy`, not merged. `previewSystemPrompt` assembles the exact prompt for runtime facts
you supply without touching any session (deterministic, `transcript` always `[]`, one hash per
template slot in `slot_hashes`); its `config_version` must be the agent's **current** one or
the answer is `409 config_version_changed`.

## Artifacts

```ts
listArtifacts(agentId: string, opts?: { page?: number; limit?: number; sessionId?: string; sourcePath?: string; createdBefore?: string }): Promise<ArtifactPage>
getArtifact(agentId: string, artifactId: string): Promise<ArtifactRecord>
downloadArtifact(agentId: string, artifactId: string): Promise<{ artifact_id?: string; url?: string }>  // 409 artifact_not_ready before finalization
deleteArtifact(agentId: string, artifactId: string): Promise<ArtifactRecord>
```

Artifacts are published by the agent's own in-loop `artifact_publish` tool during a turn; there is
**no API to publish one from your code** - these methods manage what the agent produced. Every
artifact route demands `owner_uid`+`org_id` query selectors that the gateway does not inject; the
SDK derives both from the agent's own projection and caches them per agent, so the first artifact
call on an agent costs one extra GET - do not add the selectors yourself. `listArtifacts` returns
the page verbatim (`{ artifacts, page, has_more }`): unlike `listEvents`, **this list tells you
when it truncated** - read `has_more`. The access `url` is a revocable bearer capability; treat it
as a secret and re-mint with `downloadArtifact` rather than storing it long-term.

## Environments

Platform supplies a managed Environment. Root Environment administration returns
`404 service_api.not_found` for Project keys. No caller-supplied Environment build recipe is
available through these credentials. Default compute is Pro: 4 CPU and 4096 MiB RAM.
Persistent workspace storage has no documented fixed quota or retention SLA.

## Credentials

There is no credential API on the client: the gateway seeds model credentials itself at create, so
there is nothing for an API-key caller to store. One consequence: `McpServerDeclaration.credential`
names a credential slug that is accepted and stored on the agent, but there is no endpoint to put
the secret it points at, so an authenticated MCP server cannot be made to work - declare public
servers only. See `references/not-supported.md` - End-user credential storage.

## Errors

```ts
export class ZooworkError extends Error {
  status: number
  type?: string      // absent when the server sent no code
  contentType?: string
  bodySnippet?: string
  cfRay?: string
  requestId?: string
  retryable: boolean
  constructor(status: number, message: string, type?: string)
}
```

`this.name` is `'ZooworkError'` and the class is a runtime export, so `instanceof` works; the one
failure that is **not** a `ZooworkError` is the missing-key throw from `createZooworkClient`.
**There are two error vocabularies, because there are two envelopes.** The SDK unpacks both into the
same class, but the spelling differs by family:

| Family | Envelope | `type` looks like |
|---|---|---|
| sessions, schedules, environments | `{ error: { type, message } }` | bare: `agent_not_running`, `session_archived`, `environment_not_ready` |
| agents | `{ code, detail }` | dotted: `service_api.not_found` |

The message falls back through `error.message` -> `message` -> `detail` -> `HTTP <status>`; a
non-JSON error body leaves `type` absent. **No error-code constants are exported** - `type` is a
bare `string | undefined`, with no enum, union or const array anywhere in the package. You compare
against string literals you write yourself, which is why you should **match on `status` when you
only need the class of failure** and reach for `type` only to tell two failures with the same status
apart. Never match on message text: it is prose, it is not stable, and the same condition reaches
you differently worded depending on which envelope answered. Two more things a `catch` should
expect: a cross-tenant or unknown id answers **404, not 403**, so a 404 does not mean deleted; and
two errors never came from a server at all - `waitUntilRunning`'s `408 timeout` and `0 aborted`.
`streamEvents` uses the same error parser on non-2xx open responses: JSON codes and request IDs
are preserved when available. Non-JSON failures retain status and diagnostic fields. `retryable`
is a hint, not permission to replay a write or proof the SDK retried it.

MCP tool overrides accept `requireConfirmation?: boolean`. True requires `permission: 'always_ask'`
and limits decisions to allow-once or deny; it prevents persistent grants from skipping confirmation.
False or omission retains ordinary permission behavior.

Agent deletion through the public API returns 204 once and 404 on repetition. A 404 can also hide
an inaccessible resource: reconcile cleanup only for a known Agent with unchanged key scope.

Concurrent `createAgent` calls in one Organization can return
`503 platform.runtime_credentials_unavailable` with `retryable: true`. The Agent was not created;
create Agents serially and retry with backoff and the same idempotency key.

`startAgent` can return `409 runtime_credential_unavailable` when the Agent's runtime credential
is missing or revoked. Project keys have no route that repairs it, so do not retry the start in a
loop. A request can return `409 database_conflict` when it loses a lock conflict with a
concurrent request: the transaction was rolled back, but earlier steps may have been applied.
Read the resource state before deciding whether to retry.
