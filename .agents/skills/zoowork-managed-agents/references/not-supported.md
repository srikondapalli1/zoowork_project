# ZooWork Managed Agents - Capability Boundary

Read this before you design, not after the first integration test. Every entry below is something
people routinely build on other agent platforms, and each one changes the shape of a product if you
discover it late. Each entry says what you would build, what actually happens if you try, and the
nearest thing that works.

**"The SDK has no method for it" and "it does not exist" are different claims, and mixing them up
misleads in both directions.** Before you tell a user something is missing, check
`references/typescript-sdk.md`, `references/python-sdk.md`, or the shipped SDK declarations. The
SDKs expose core Agent/Session lifecycle plus Artifacts, Usage, Agent webhooks, Run Output and
action detail/paging. Their Database viewer helpers exist, but the production viewer is unavailable. Check the installed release and read
`developer-api.md`. A method does not extend the current key's Project permissions.

## Programmatic usage and cost reporting

`getUsage` / `get_usage` query `/service/v1/usage` within the current key scope; the Organization
balance is readable too. Preserve snapshot and cursor tokens and distinguish reporting from a
spending limit. The Session API
has no per-session dollar cap or pause/resume budget contract. See `developer-api.md`.

## Application-executed custom tools

**What you would build.** Declare a tool with a JSON schema, let the model decide to call it, run
the function in your own process against your own database, and hand the result back so the same
turn continues with it.

**What actually happens.** This contract now exists. Declare up to 32 entries under
`resource.custom_tools`; the run emits `agent.custom_tool_use` and waits; your application resolves
the `callId` with `resolveCustomToolCall()` / `resolve_custom_tool_call()` or a
`user.custom_tool_result` event. Result content accepts bounded text, JSON, and base64 images.
`listCustomToolCalls({ status: 'pending' })` / `list_custom_tool_calls(status="pending")` recovers
work after a process restart. The Session reports `run_status: 'awaiting_approval'` while paused,
so use the separate `pending_custom_tool_calls` count to distinguish this from human approval.

**Current evidence.** Production checks on 2026-10-03 drove the loop end to end with both SDKs:
the request event, pending-call listing, REST resolution, `user.custom_tool_result` resolution,
and the run continuing with the returned value. A 202 result receipt with `signaled: true` can
remain pending until the run consumes it; do not interpret it as completed execution.

**Use MCP instead when the platform should call a remote server directly.** This is real and
has been exercised end to end for public, unauthenticated servers: the tools appear in the model's
manifest as `mcp__<server>__<tool>` and really execute.

```ts
await zc.createAgent({
  resource: {
    name: 'support-agent',
    mcp: [{
      name: 'orders',
      url: 'https://mcp.example.com/mcp',
      transport: 'streamable-http',
      exposure: 'deferred', // omission default; use 'direct' for the first model request
      context: { meta: true }, // opt-in runtime ids; context, not authentication
      permission: 'always_ask',
      tools: { quote: { permission: 'always_allow' } }, // exact native tool name
    }],
    //      ^ no underscore: tool names are `mcp__<server>__<tool>`, so an underscore in the
    //        server name makes the split ambiguous and the server is rejected
  },
})
```

`mcp` is an agent-level declared section, so `updateAgent(agentId, { mcp: [...] })` changes it
later. Remote HTTP only - `streamable-http` (the default) or `sse`; there is no stdio transport and
no OAuth. The URL must be publicly reachable: loopback, private ranges, cloud metadata addresses
and redirects are all refused. A server that fails its catalog probe does not fail the run; it can emit `agent.error` with `kind: 'mcp_connection_failed'` or
`'mcp_authentication_failed'` and optional `reason` (`mcp_connection_failed` observed in production; retain unknown values).
Transient failed catalogs can expire so a later resolution probes again. Healthy catalogs remain
configuration-bound; this is not periodic auto-recovery or a guarantee that business calls retry.

`exposure` is either `deferred` (also the omission default) or `direct`; there is no `auto`.
Deferred tools load through `tool_search` / `tool_describe` and remain available on later turns in
the same Session. `direct` declares them on the first model request. Both modes were exercised in production:
`direct` tools were called on the first request, and `deferred` tools were loaded through
`tool_search` / `tool_describe` before the call.

Runtime context and approval behavior are separate opt-ins. `context.meta` adds
`_meta["ai.zooclaw/context"]`; `context.headers` adds `x-zooclaw-*` headers to tool execution.
Both default to false, catalog discovery carries neither, and intermediaries may strip headers.
The context can include agent/session/computer ids and optional run/turn/config/actor fields, but
it is not authentication and must not be trusted as proof of the caller.

`permission` sets `always_ask` or `always_allow` for the server, while `tools` overrides exact
native MCP tool names. Wildcards are not accepted in `tools`, and the map is capped at 64 entries.
Omission is default-allow. An allow-always decision on the server wildcard covers every tool from
that server for the Session. In production checks a server-level `always_ask` produced an
approval request that `allow-once` resolved; per-tool overrides are source-reviewed.

The real limit is authenticated identity. `McpServerDeclaration.credential` names a slug for a single static
bearer token, and the endpoint that would store the secret behind that slug answers 404 through the
gateway by design - so **authenticated MCP is not usable**. The declared credential is one shared
value for the whole agent in any case. Runtime context can identify an `actorUid` when available,
but it is not a credential or a signed assertion. If your product needs to act as the signed-in
user, this option cannot get you there without your own authentication layer in front of the MCP
server.

**Use a second turn when you do not want to park a run.** Let the turn finish, do
the work yourself, and post the answer as the next message. It costs one extra turn and it is
entirely inside the verified surface.

```ts
const s = await zc.createSession(agentId, {
  initial_events: [{ type: 'user.message', content: 'Where is my order? Ask with ORDER_LOOKUP(<id>) if you need data.' }],
})

let reply = ''
let cursor: string | undefined
for await (const ev of zc.streamEvents(agentId, s.session_id)) {
  cursor = ev.cursor ?? cursor
  reply += assistantText(ev)
  if (isRunFinished(ev)) break // the stream does NOT close at turn end - break or you wait for the idle timeout
}

const ask = /ORDER_LOOKUP\(([^)]+)\)/.exec(reply)
if (ask) {
  const order = await myDatabase.findOrder(ask[1]) // your code, your credentials, your process
  await zc.postEvents(agentId, s.session_id, [
    // system.message carries its body in `text`. `content` is the user.message field, and the
    // open OutboundEvent type will not catch the mix-up for you.
    { type: 'system.message', text: `Order lookup result: ${JSON.stringify(order)}` },
    { type: 'user.message', content: 'Answer the customer using that data.' }, // system.message alone does not start a turn
  ])
  let answer = ''
  for await (const ev of zc.streamEvents(agentId, s.session_id, cursor ? { cursor } : {})) {
    cursor = ev.cursor ?? cursor
    answer += assistantText(ev) // resumed from the cursor: no gap, no duplicate frame
    if (isRunFinished(ev)) break
  }
}
```

`system.message` injects context the model reads on its next turn without appearing as a user turn,
which keeps your injected data out of the visible conversation. It does not start a turn on its
own, so pair it with a `user.message` when you need an answer now.

---

## End-user credential storage

**What you would build.** A vault per end user holding their third-party tokens, so the agent acts
as that user against their calendar, their repo, their CRM.

**What actually happens.** There is no vault resource of any kind and no credential methods on the
client: the gateway owns the credential layer and seeds model credentials itself at create.
`McpServerDeclaration.credential` accepts a slug and stores it on the agent, but the slug points at
a store you cannot write to.

**Why.** Your Project key authenticates backend access within its Project. There is no end-user principal
anywhere in this API for a secret to be scoped to, so there is nothing for a vault to key on.

**What to do instead.** Keep end-user secrets in your own backend and never let them cross into the
platform. Make the calls that need them from your own process and pass results in as messages, as
in the second-turn pattern above. Do not smuggle a secret into an agent's persona docs, a skill file, or session
`metadata`: persona and skills are agent-wide and shared by every session, and any authorized key holder can read them back.

---

## Message attachments and repository mounting

A Session `user.message` carries text only, and there is no repository mount contract. To give
the Agent a file, upload it into `/workspace` and name its path in the message; follow
`developer-api.md` for the upload flow. Ask the Agent to publish output with its
`artifact_publish` tool and retrieve it through the Artifact API. The workspace Files methods
in the SDK fail with HTTP 501 or 502 on the hosted service; do not call them.

Sessions of one Agent share workspace files. Published Artifacts are separate immutable
copies, not live workspace files. Treat download URLs as bearer credentials.

Use an Agent per user for file isolation. `actor.ref` does not isolate files. Do not introduce
a repository clone recipe that requires putting private credentials in Agent instructions or files.

## Outcome definitions on interactive sessions

**What you would build.** Declare acceptance criteria on a session, let the agent iterate until it
meets them, and read a grade off the result.

**What actually happens.** Not on a session. There is no outcome event among the five write-side
types, no rubric field on `createSession`, and no score in any session event payload.

**What to do instead - unattended cron work has the real thing.** A schedule's `payload.outcome`
(or an agent-level default at `resource.outcome`) carries a `description`, a `command` or `rubric`
evaluator, `maxIterations` (1-5) and a `publish` policy; the run iterates against it internally
and, under the default `publish: 'after_satisfied'`, announces nothing that failed evaluation. See
`references/typescript-sdk.md` - Schedules. **For interactive sessions**, grade in your own
process, where you can also version the rubric. You have the material:
`listAllEvents(agentId, sessionId)` returns every durable event without the silent 500-event
truncation that `listEvents` has, and `getSession(agentId, sessionId, { history: true })` returns
the at-rest transcript, which is the one surface that also carries token usage and the model that
actually served the turn. Run your own judge over that, and post another `user.message` when the
answer falls short. Each iteration is one turn, and the loop lives in your code.

---

## Human approval signals

The approval loop is available through REST resolution and `user.tool_confirmation`.
Waiting emits `agent.approval` with `phase: 'requested'`; show its approval and tool IDs to
an authorized reviewer. Resolve only an allowed decision from `allowed_decisions`.
`phase: 'resolved'` ends the approval wait but does not prove execution succeeded. A 202
REST resolution with `signaled: true` may still show pending until the run consumes it.
Use `listApprovals(agentId, { status: 'pending' })` to recover pending decisions after restart.

`agent.tool` / `blocked` ends a call without execution. Reasons include policy denial,
approval denial/timeout/cancellation, or interruption; inspect the raw event payload's
`deniedReason`. It is not an approval request, and no `end` follows for that blocked call. Do not wait for blocked to
render an approval UI. Use exact per-tool overrides when a server-wide grant is too broad.

---

## Listing sessions across agents

**What you would build.** One inbox: every session belonging to every agent you own, newest first,
one call.

**What actually happens.** There is no top-level sessions collection. The legacy
`listSessions(agentId, { page })` / `list_sessions(agent_id, page=...)` lane is per Agent, newest
first and fixed at 50 rows. The separate `listSessionPage()` / `list_session_page()` cursor lane
adds filters and resumable scans, but it is still per Agent.

**What to do instead.** Fan out over `listAgents()` and call `listSessions` per agent - but know
the limit before you rely on it: `listAgents` applies the key's Project and owner visibility, and
reading by ID applies the same authorization, so an Agent a colleague created can be absent from
the list and answer 404 by ID. The durable answer is to keep your own index of agent ids and
session ids in your own database, keyed by your own user id. You need that index anyway: the
platform has no notion of your end-user authorization. `actor.ref` can attribute messages, but it
does not replace your session ownership index or grant access.

---

## A memory store resource

There is no public memory-store create/mount/CRUD API. Agent-managed memory tools operate during
turns; an authenticated backend can attribute `user.message` with `actor.ref`. Attribution is
not authorization or file isolation. For externally managed facts, use your own database and
pass relevant facts as inputs or expose a controlled custom tool.

## Platform signed webhooks

Agent webhook registration, management, delivery inspection and redelivery are public. Use
`developer-api.md` before implementing a receiver. Verify raw bytes, check body/header identity,
atomically persist the deduplicated event and worker item, then acknowledge. Unknown types must
remain accepted. A 202 test/redelivery receipt is queuing, not delivery or business completion.

## Agent version pinning and rollback

**What you would build.** Pin an agent to a known-good configuration version, ship a prompt change,
and roll back when it regresses.

There is no public configuration-history or rollback endpoint. Explicit `runtime_mode: "active"`
on Session creation pins the current active configuration. Omission resolves active configuration
on later turns. Agent updates support atomic optimistic concurrency through optional positive
`expected_config_version`; stale versions return `409 active_config_changed` without changing
configuration. Re-read and recompute the intended change before retrying; omit the field for
last-write-wins updates. That precondition does not provide configuration history or rollback.
Keep prior configuration in source control and reconcile declared values before retrying
uncertain writes.

---

## Self-hosted tool execution

**What you would build.** Run the sandbox on your own machines - your worker pool, your network,
your data never leaving it - while the platform still drives the agent loop.

**What actually happens.** Nothing relocates the sandbox or exposes a worker fleet. There is no
worker registration, durable background queue, or environment key that points sandbox execution
somewhere else. Platform supplies its managed sandbox Environment. Custom
tools let a waiting run request work from your application, but do not turn your process into a
registered sandbox worker.

**What to do instead.** If the goal is reaching a private system, use an application-executed
custom tool, run a public MCP endpoint at the edge of your network - which must be safe to expose
unauthenticated - or keep that work in your own process between turns. If the goal is
controlling egress, note that the managed default Environment allows `unrestricted` outbound
access, and Project keys cannot create or select an Environment with a narrower `networking`
policy. Keep network access that must be restricted in your own backend or a custom tool.

---

## Smaller absences

| Capability | Public boundary |
|---|---|
| Session-local model/tools/MCP overrides | Configure the Agent or create a separate Agent. |
| Root Environment administration | Unavailable to Project keys; methods do not grant permissions. |
| Several connections of one platform on one Agent | Each Agent has one connection per platform. Use another Agent for a second account. |
| Skill registry publishing | Source-reviewed Project-key support has scope and deployment requirements; see [Skill registry](./skill-registry.md). Do not infer that publishing is unavailable from Environment restrictions. |
| Schedule cleanup | Stop/delete does not clean schedules; remove schedules before deleting the Agent. |
| Message attachments | A Session message carries text only. Upload the file into `/workspace` (see `developer-api.md`) and name its path in the message. |
| Programmatic end-user credential store | Keep credentials in your backend and call controlled custom tools. |
| Key management | Create and manage Project keys in https://platform.zoowork.ai. Secrets are shown once. |

## When you are unsure

The TypeScript SDK's shipped `dist/index.d.ts` and the Python package's public annotations carry
the exact client signatures. Prefer them over anything recalled, then use
`references/typescript-sdk.md` or `references/python-sdk.md` for the reviewed behavior and
verification status. When a capability is absent from both the selected SDK and these references,
say that it is unverified rather than guessing in either direction.

## Database viewer and paused schedules

The production database viewer is unavailable, even though the SDK exposes catalog/rows
methods. Use the Agent's `agent_db` tool through a Session and return data in its response or
an Artifact. Changing pagination or creating a database does not enable the viewer.

A disabled Schedule cannot be manually executed. Its trigger receipt can say `triggered: true`
while work is skipped. Enable it first, understanding that automatic firings also become
active, or test the task in an ordinary Session. A receipt is not an execution result.
