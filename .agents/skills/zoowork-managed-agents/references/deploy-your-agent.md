# ZooWork - Deploying an Agent You Built Locally

You have a persona, one or more skill directories, and a front end you can host. What you do not
have is somewhere for the agent loop and its skills to run. This file turns that into a hosted
Agent with persona instructions, catalog or uploaded Skills and Session task inputs. Verify
configuration, then run a real turn only when authorized; keep your backend in front of it.

Run the steps in order, and perform each verification - several of these calls report success in
ways that do not prove the effect landed. Verify declared configuration and resolved Skills
separately from runtime behavior.

## Step 0. Take stock

Map local inputs onto supported Platform resources before writing calls.

| What you built locally | Where it goes | What to know |
|---|---|---|
| System prompt, persona file, `CLAUDE.md` / `AGENTS.md` | `resource.persona.docs[]` on `createAgent` | An array of `{ name, content }`, not a map. Only canonical names reach the model, so rename `CLAUDE.md` or a system prompt file to `AGENTS.md`. Editable later with `updateAgent` |
| A skill directory containing `SKILL.md` | ZIP upload to the Skill registry, then an Agent binding | Check deployment support and Project write scope. Steps 4 and 5 |
| Custom tool / function definitions | `resource.custom_tools`; your application handles `agent.custom_tool_use` and resolves the call | Verified in production with REST resolution and `user.custom_tool_result`. Keep a pending-call recovery loop |
| Local text task data | A `user.message` in a Session | Read text in your application and include it in the message. Ask the Agent to create any needed files in `/workspace`; this is not a directory upload or mount |
| Your chat UI | Stays yours | It talks to your backend, never to ZooWork. Step 9 |
| Per-end-user secrets or accounts | **Nowhere.** Vaults and credential APIs do not exist | `references/not-supported.md` - End-user credential storage |

Choose `sandbox.scope` at create time. Agent scope is required by `exec`. Session scope creates
separate sandbox instances, while the Agent workspace remains shared. Use an Agent per user
when files must be isolated. Platform supplies its managed Environment; Project keys do not
administer root Environment builds.

---

## Step 1. Choose a model from `listModels()`

Select a model id from the live catalog, so a name recalled from another platform
is a 400 rather than a fallback. Ask the server what exists. Omitting the model pins whatever
platform default is current at create time; catalog defaults can rotate; select a returned, selectable model explicitly.

```ts
const models = await zc.listModels()
// The platform's primary chat default; persist the returned id as your explicit choice.
const model = models.find(
  (m) => m.selectable !== false && m.default_for?.includes('model'),
)?.model
if (!model) throw new Error('choose an explicit model returned by listModels()')
```

**Verify:** the selected row has `selectable !== false` and `model` is a full id including its
prefix. The catalog can retain draining or retired rows for existing Agents; selecting one for a
new config returns `409 model_not_selectable`. Refresh and use `expired_fallback_to` when present.
This call touches no agent and creates nothing, so it doubles as the cheapest proof the key works.

---

### Choose the thinking level

Read the selected model's `thinking.default` and `thinking.levels` before setting
`model.thinking`. Leaving it unset follows the platform default. A higher level generally
uses more reasoning tokens and increases latency; `off` does not disable reasoning on every
model. Read [Thinking levels](./thinking-levels.md) for capability resolution, partial updates
and when existing Sessions receive a changed setting.

## Step 2. Create the agent

`persona.docs` is where the local system prompt lands. Each entry is a named document the agent
reads as standing instruction. Only these names are read when the prompt is assembled:
`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, and `HEARTBEAT.md`. A document with
any other name, such as `CLAUDE.md`, is saved but never reaches the model, so put the local system
prompt in `AGENTS.md`. `MEMORY.md` and the `memory/` namespace are reserved and return
`400 invalid_persona_doc_name`.

`labels` earn their keep immediately: `listAgents({ labels })` filters on them server-side, which
is how you find this agent again from a fresh process without a database.

This example uses the paginated `listAgents()` return; check the installed SDK against
[the pagination reference](./typescript-sdk.md#agents). SDK 0.5.2 returns an array instead.

```ts
const LABELS = { app: 'deck-editor', env: 'prod' }
const persona = await readFile('./AGENTS.md', 'utf8')

// Converge on ONE agent instead of creating another on every deploy.
const { data: existing } = await zc.listAgents({ labels: LABELS })
let agentId = existing[0]?.agent_id

if (!agentId) {
  const created = await zc.createAgent(
    {
      resource: {
        name: 'deck-editor',
        model: { primary: model },
        persona: { docs: [{ name: 'AGENTS.md', content: persona }] }, // ARRAY of {name, content}
        labels: LABELS,
        sandbox: { scope: 'agent' }, // one /workspace for the agent; required by exec
      },
    },
    'deck-editor-prod-v1', // stable idempotency key, NOT a per-deploy uuid
  )
  agentId = created.agent_id // agt_... - persist this
}
```

**Why the idempotency key matters more here than anywhere else.** A duplicate session is a wasted
turn; a duplicate *agent* is a second sandbox, a second `/workspace`, a second set of attached
skills, and a second id that half your traffic is now talking to. Nothing in the product cleans
that up, and the two agents drift the moment either one writes a file. Know what the key does and
does not buy you, though: the SDK forwards it as an `Idempotency-Key` header, while
historical convergence evidence in this example does not cover every create family. Source-reviewed
HTTP-key contracts cover Agent and Session; schedules use stable IDs and identical definitions. The `listAgents` lookup above is
the part you can verify, and its one limit is scope - the selected Project and applicable owner visibility limit results. Persist the Agent id
in application storage so a key change does not cause accidental duplicate provisioning.

**Verify:**

```ts
const agent = await zc.getAgent(agentId)
console.log(agent.status?.config_version, Object.keys(agent.declared ?? {}))
```

The read is a different shape from the create receipt: `getAgent` returns a projection with your
configuration under `declared` and the version at `status.config_version`, while `createAgent`
returned a flat receipt with a top-level `config_version` and no `declared` at all - read it as
`agent.status?.config_version ?? agent.config_version` if you need one expression for both. Confirm
`declared.persona` holds the text you sent; that is the proof the persona landed, not the 201.

**On `tool_policy`.** The SDK keeps the object open, but source review now fixes the matching
syntax: exact names, global `*`, or one trailing `prefix*` work in allow/deny/rule match/afterRules
and deferred MCP pinned entries. Other `*` placements match nothing, and `alsoAllow` remains
exact-only. Production checks verified exact-name `allow` and `deny` lists removing tools from a
turn, and `permissions: { exec: 'always_ask' }` gating a call. That is evidence of approval
behavior, not a recommendation to add it to every Agent. Before choosing permissions, read
[Tool permissions](./tool-permissions.md): keep application review where required, and use
`always_allow` only for tools authorized to run autonomously. An unattended run with
`always_ask` needs a decision handler for its whole lifetime. The wildcard forms are
source-reviewed. A policy the runtime cannot parse - an `argsPattern` or `resultPattern` that is
not RE2 syntax (lookaround, backreferences and inline flags are rejected; at most 512 characters),
an unknown rule action, a rule without `id`, non-array `rules`, more than 64 rules or more than
32 KiB - is rejected at write time with `400 invalid_request` naming the field, so fix the policy
rather than retrying the call. After provisioning, run a turn that should be blocked and inspect
`agent.tool` instead of treating a successful create as proof the policy took effect.

A hosted Agent can rewrite its own persona documents through the `persona_doc_update` tool, and
later turns read them as instructions. Add `persona_doc_update: 'always_ask'` to
`tool_policy.permissions` to review each change, and deny `cron` unless the Agent should manage
its own schedules.

---

## Step 3. Start it, and wait on `desired_state`

A newly created agent is not running. Every session call against it is `409 agent_not_running` until
you start it.

```ts
const { warnings } = await zc.startAgent(agentId)
// Successful warnings are informational; a non-2xx or transport failure still throws.
if (warnings.length) console.log('start warnings:', warnings)

const running = await zc.waitUntilRunning(agentId, { timeoutMs: 60_000 })
console.log(running.status?.desired_state) // 'running'
```

Do not hand-roll this loop. The readable-looking field, `status.actual_state`, is not readiness:
an enabled Agent with a rendered config reports `active` whether or not a channel is connected or
a turn can run, and `status.channels` holds fixed placeholder counts. `running` is not one of its
values. `waitUntilRunning` polls `desired_state`, bounds each in-flight
request as well as the gap between polls, and throws a `ZooworkError` with
`status: 408` / `type: 'timeout'` when the budget runs out.

**Verify:** `running.status?.desired_state === 'running'`. Nothing else is readiness.

---

## Step 4. Upload or select Skills, then supply task inputs

Read [Skill registry](./skill-registry.md) before uploading a local Skill directory. Package each
Skill separately, use the key's permitted scope, save its returned `skill_id`, and attach it with
`putAgentSkill` / `put_agent_skill`. On a deployment with Project-key registry support, a named
Project key uses `project` scope and a Default Project key uses `org` scope. This contract is
source-reviewed; confirm deployment support and inspect the installed SDK before making writes.
Do not claim that a local ZIP has been uploaded until its request succeeds.

New Agents receive global Skills by default. For existing catalog Skills, choose by `name` or
`skill_id` at create time. Inspect `listAgentSkills(agentId)` after binding either kind of Skill.
Put standing persona instructions in `persona.docs`; this does not package scripts or resources
from a local Skill folder. Read local text task data in your application and include it in a
Session `user.message`. Ask the Agent to publish outputs with `artifact_publish` and retrieve
those through the Artifact API. Skill ZIP publishing is not task input; to give the Agent a
local file for a task, follow the upload flow in `developer-api.md`.

## Step 5. Verify the declared configuration

Read `getAgent` and `listAgentSkills`; compare the desired persona and resolved assignments.
A configuration version alone is not proof your instructions changed. Read the current version
as `agent.status?.config_version ?? agent.config_version` and send it as top-level
`expected_config_version` with the intended update for an atomic precondition. A stale version
returns `409 active_config_changed` without changing configuration; re-read and recompute the
change before retrying. Omit the field for last-write-wins updates.

## Step 6. Smoke test with a real turn that should use a skill

Ask for something only the skill knows how to do. A generic "hello" proves the agent runs and
proves nothing about the deployment you just performed.

```ts
const session = await zc.createSession(agentId, {
  initial_events: [
    { type: 'user.message', content: 'Review the structure of a 12-slide pitch deck and list what is missing.' },
  ],
  metadata: { origin: 'deploy-smoke-test' }, // write-once: there is no patchSession
})

let reply = ''
let cursor: string | undefined
const calls: string[] = []

for await (const ev of zc.streamEvents(agentId, session.session_id)) {
  cursor = ev.cursor ?? cursor
  reply += assistantText(ev) // '' for every event that is not agent.assistant
  const call = toolCall(ev)
  if (call?.phase === 'start') calls.push(`${call.toolName} ${JSON.stringify(call.args ?? {})}`)
  if (isRunFinished(ev)) {
    if (runOutcome(ev) !== 'succeeded') throw new Error(`run ${runOutcome(ev)}`)
    break // the stream is session-scoped and does NOT close at turn end
  }
}

const consulted = calls.some((c) => c.includes('/skills/deck-review/'))
console.log({ consulted, calls, reply: reply.slice(0, 200), cursor })
```

**How to read that.** No event announces "skill selected". What happens is that the model reads the
skill file, and reading a file is a tool call - so a matching `agent.tool` event is the evidence.
Match on the skill's path (`row.location` from Step 5) appearing in the call's `args` rather than on
a tool name: which tool the runtime uses to read files is not pinned anywhere in the SDK, and
hardcoding a guess makes your check fail for the wrong reason. If `consulted` is false but the run
succeeded, inspect the resolved assignment, its location, and the task instructions. A description
may not have matched the task. For an updated ZIP, publish a version using the registry guide;
check the binding's version pin and verify runtime behavior separately.

A real turn can incur usage. Configuration inspection is read-only; obtain authorization before
starting live runtime verification. Do not promise a fixed cold-start latency.

---

## Step 7 (optional). Look inside `/workspace` with `exec`

When the agent's answers suggest it is not seeing the files you think it is, inspect the sandbox
directly.

```ts
const out = await zc.exec(agentId, ['bash', '-lc', 'ls -la /workspace && head -20 /skills/deck-review/SKILL.md'])
if (out.exit_code !== 0) console.error('command failed:', out.exit_code, out.stderr)
console.log(out.stdout)
```

`args` is argv, not a shell string - `['ls', '/workspace']` runs `ls`, and anything with a pipe, a
redirect, or a glob needs the explicit `['bash', '-lc', '...']` wrapper. **A non-zero exit is still
HTTP 200:** the promise resolves and only `exit_code` tells you the command failed; the call rejects
only when the call itself fails. `cwd` is fixed to `/workspace`, the default timeout is 300s, and
stdout and stderr are each capped
at 200,000 characters. Three failures are configuration rather than bugs: `409
exec_requires_agent_scope` (you created the agent with `sandbox.scope: 'session'`),
`409 exec_config_not_ready` (config not rendered yet - worth one retry after a few seconds), and
`501 not_configured` (the deployment has no sandbox backend).

---

## Step 8 (optional). Put it on a schedule

```ts
await zc.createSchedule(
  agentId,
  {
    schedule_id: 'nightly-deck-audit', // ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$
    schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Singapore' }, // five fields, no macros
    payload: { kind: 'agentTurn', message: 'Audit the decks in /workspace and summarize changes.' },
    sessionTarget: 'isolated', // fresh session per fire; IMMUTABLE after create
    delivery: { mode: 'none' },
    enabled: true,
  },
  'nightly-deck-audit-v1',
)
```

**Verify.** Use the public `schedule_id` on create/read. Read the saved definition back;
compatibility fields can include `name` and `scheduleId`. The cadence is at
`scheduleSpec.cronExpressions[0]`; do not echo the projection as an update body.

```ts
const stored = await zc.getSchedule(agentId, 'nightly-deck-audit') // the SHORT id you chose
console.log(stored.schedule_id, stored.enabled, stored.scheduleSpec?.cronExpressions?.[0])
```

Three things to know before you rely on this:

- **Schedules outlive their agent.** `stopAgent` and `deleteAgent` leave them in place. While the
  Agent is stopped or deleted, each fire is skipped with reason `runtime_stopped`. You list and
  delete them yourself - see Step 10.
- **A `getSchedule()` result is not a legal PUT body.** Four of its fields are server-derived and
  answer 400, `sessionTarget` is `400 sessionTarget is immutable`, and `scheduleSpec` - the only
  place a read puts the cadence - is accepted with a 200 and then silently ignored. To change the
  cadence, send `schedule: { kind: 'cron', expr, tz }`, the input vocabulary. The types refuse all
  six at compile time and the SDK strips them at runtime, so the read-tweak-write round trip works
  from TypeScript; from plain JavaScript, know what you are sending.
- **Overlap policy is skip.** A fire that lands while the previous one is still running is dropped,
  not queued. Size the cadence for the slowest run you expect.

To find what a fire produced: on an enabled schedule, production fires produced
`listScheduleRuns` rows carrying `session_id`. It remains optional; follow it when present. Otherwise inspect `listSessions(agentId)` and match
`channel === 'cron'` with a `session_key` beginning `agent:{agent_id}:cron:{schedule_id}:`. And
`triggerSchedule` answering `triggered: true` acknowledges a request, not execution. A disabled
schedule is skipped and its run row can lack status/session linkage. Enable before triggering;
this also activates automatic firings. Use `schedule.skipped` webhooks to observe skip reasons.

---

## Step 9. Wire up your own front end

Starting from an empty directory, the official starter (`starter/` in
<https://github.com/SerendipityOneInc/zoowork-platform-quickstarts>) is one option: it implements this
shape for one Agent in a fixed Next.js stack. Offer it as described in `SKILL.md`; otherwise wire the
Agent into the user's own backend as below.

The Project key belongs on your backend. It authorizes access within its Project and does not
authenticate your application's end users. Keep it out of browser/mobile bundles and logs.

The shape is `browser -> your backend -> ZooWork`, where your backend holds `ZOOWORK_API_KEY`,
authenticates your user, and looks up the sessions it created for them. One agent, one session per
conversation, is the normal design: the agent is the product, the session is the thread.

```ts
// POST /api/conversations - your route, your auth
const user = await authenticateYourUser(req)      // your problem, not ZooWork's
const session = await zc.createSession(AGENT_ID, {
  metadata: { user_id: user.id },                 // write-once, at create
})
await yourDb.conversations.insert({ user_id: user.id, session_id: session.session_id })

// POST /api/conversations/:id/messages
const row = await yourDb.conversations.findOne({ id, user_id: user.id }) // authorize HERE
await zc.postEvents(AGENT_ID, row.session_id, [{
  type: 'user.message', content: req.body.text,
  actor: { ref: user.actorRef }, // stable, validated backend mapping; not a credential
}])
```

**You must store the session ids yourself.** Session listing is per-agent. The legacy
`listSessions(agentId, { page })` path is newest first and fixed at 50 rows; `listSessionPage()`
adds a filtered cursor lane, but there is still no cross-agent
session listing and no way to query sessions by end user. The `metadata` you set at create is
readable but not searchable, and write-once besides - there is no `patchSession`. Your database is
the index, and it is also your authorization boundary: the API applies Project resource scope, and your backend must separately check that a
Session belongs to the signed-in application user.

Per-user context belongs in the session, not in the agent - post a `system.message` event to tell
the agent which plan the user is on or what they just clicked, rather than rewriting the persona.
Source-reviewed `actor.ref` attributes API messages; session metadata alone does not select it.
It is not authentication or a file/session access boundary. If users must not share an agent-scope
`/workspace`, use an agent per user (Per-user deployment) and keep your own authorization checks.

For streaming, your backend runs `streamEvents` and re-emits to the browser in whatever format your
UI wants, checkpointing the last successfully processed `ev.cursor` and resuming with `{ cursor }`
- the SDK does not reconnect for you. See `references/events-and-streaming.md` - Reconnecting.

---

## Per-user deployment

An Agent per user separates workspace files and sandbox state. Persist the mapping in your
backend, authorize the user before every read/write, and use stable idempotency keys for
provisioning. Keep shared persona and instructions in application source control; compare
current declared state and pass its positive `expected_config_version` with each computed
update. On `409 active_config_changed`, re-read and recompute rather than replaying a stale
body with a new version. Omit the precondition only for intentional last-write-wins updates.

Provision serially. Concurrent `createAgent` calls in one Organization can return
`503 platform.runtime_credentials_unavailable` before any Agent is created; retry with backoff and
the same idempotency key instead of fanning out creates with `Promise.all`.

## Step 10. Tear down a throwaway experiment

Order matters: `deleteAgent` is a soft delete, not proof that schedules and sandbox resources
have been cleaned up. Stop and explicitly manage the resources your experiment owns.

```ts
// 1. Schedules first - they outlive the agent, and after deletion its schedule routes
//    answer 404, so you can no longer delete them.
for (const s of await zc.listSchedules(agentId)) {
  const id = s.schedule_id ?? s.name ?? (s.memo?.schedule_id as string | undefined)
  if (id) await zc.deleteSchedule(agentId, id)
}

// 2. Stop. This cancels running work and blocks new Sessions; it does not destroy the sandbox.
//    If this throws after desired state was written, read getAgent and reconcile.
await zc.stopAgent(agentId)

// 3. Delete the agent.
await zc.deleteAgent(agentId)

```

**Verify:** `listSchedules(agentId)` is empty before you delete, and `listAgents({ labels: LABELS })`
no longer returns the agent afterwards. A 404 from `getAgent` is not proof of deletion on its own -
an unknown or cross-tenant id answers 404 too, so a typo looks exactly like success.
