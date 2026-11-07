---
name: zoowork-managed-agents
description: Build on ZooWork Managed Agents through the `@zoowork-ai/sdk` TypeScript SDK or `zoowork` Python SDK. Use whenever ZooWork, a `zwp_live_`, `agt_`, or `skl_` identifier, `ZOOWORK_API_KEY`, a ZooWork Agent or Session, streaming events, custom tools, MCP, platform Skills, Environments, channels, schedules, thinking levels or reasoning effort, approvals, or ZooWork API errors are mentioned. Inspect the installed SDK version and read the routed reference before writing ZooWork code.
license: MIT
---

# Building on ZooWork Managed Agents

Start with the user's task, then read only the documentation that owns it. The public API is a
Developer Preview, so do not write ZooWork code from memory, and inspect the installed SDK before
relying on a remembered signature.

The public docs are the primary source. Fetch the page Markdown, not the rendered HTML:

- <https://zoowork.ai/docs/llms.txt> lists every page with a one-line summary.
- Each page is available as Markdown at `https://zoowork.ai/docs/<section>/<page>.md`, for
  example <https://zoowork.ai/docs/get-started/quickstart.md>. Do not add a locale prefix such as
  `/en/`.
- Avoid `llms-full.txt` unless the task genuinely spans the whole site; it is large.

The `references/` files in this skill add SDK detail that is not yet in the docs. When a reference
and the docs disagree, follow the docs and the installed SDK.

## Four invariants

These are the most common reasons code compiles but fails at runtime:

1. `createAgent` creates a stopped Agent. Call `startAgent(id)` and wait for `desired_state` before
   opening a Session.
2. Every Session method takes `agentId` first.
3. Assistant text comes from `agent.assistant` through `assistantText()` / `assistant_text()`.
4. A Session stream does not close at turn end. Break on `run.finished` through
   `isRunFinished()` / `is_run_finished()`.

## Preflight

Before writing code:

1. Read `package.json`, `pyproject.toml`, lockfiles, and existing imports.
2. Determine whether the project uses `@zoowork-ai/sdk` or `zoowork`, and record its installed
   version. Do not upgrade it unless the user asks.
3. Check whether `ZOOWORK_API_KEY` and `ZOOWORK_BASE_URL` are present without printing their values.
4. Reuse the project's existing client and configuration style.
5. If the installed package ships `AGENTS.md` and `CHANGELOG.md` (TypeScript 0.14.0+:
   `node_modules/@zoowork-ai/sdk/dist/AGENTS.md` and `node_modules/@zoowork-ai/sdk/CHANGELOG.md`;
   Python 0.9.0+: `AGENTS.md` and `CHANGELOG.md` inside the installed `zoowork` package), read
   them. When the docs rely on a method the installed release lacks, tell the user which release
   adds it instead of upgrading silently.
6. Read the routed docs page and reference below. For an exact method or type, verify the
   installed declarations or Python source as the final authority.

If no project is present, state which package and runtime the example assumes. Install the
published package with `npm install @zoowork-ai/sdk` or `python -m pip install zoowork`. The
Quickstart's Prerequisites section states the SDK releases and runtime versions the docs assume;
read it rather than relying on a remembered version. If an existing project pins an older release,
say so and ask before upgrading.

## Route by task

Docs paths are relative to `https://zoowork.ai/docs/`.

| User intent | Docs page | Skill reference |
|---|---|---|
| First integration, API key, or funding | `get-started/quickstart.md`, `get-started/authentication.md` | - |
| Set or clear Agent thinking, reasoning effort, model thinking capabilities, or Schedule thinking overrides | `build/agents.md`, `reference/models.md`, `build/schedules.md` | `references/thinking-levels.md`, then the language reference |
| TypeScript method, option, return shape, Agent config, model, MCP, Environment, channel, schedule, artifact, `exec`, or `wake` | `reference/typescript-sdk.md`, plus the matching `build/` page | `references/typescript-sdk.md` |
| Approvals, `always_ask` / `always_allow`, unattended jobs, or MCP permission defaults | `build/permissions.md`, `build/tools.md` | `references/tool-permissions.md`, then the language reference |
| Securing a deployment, prompt injection, data boundaries, or monitoring Sessions for misuse | `security/secure-deployment.md`, `security/risks-and-boundaries.md`, `security/monitor-sessions.md` | - |
| Python import, snake_case method, return shape, event helper, custom tool, Session cursor, Agent config, MCP, or channel | `reference/python-sdk.md`, plus the Python tabs of the matching `build/` page | `references/python-sdk.md` |
| Sending a local file (PDF, image, CSV, any bytes) to an Agent, text task inputs, file outputs, Database availability, Usage, Organization balance, webhook registration/verification/delivery diagnostics, Run Output, or action paging/detail | `build/files.md`, `build/data-storage.md`, `reference/usage.md`, `build/webhooks.md`, `build/session-operations.md` | `references/developer-api.md` |
| Stream replies, reconnect, render events or tool calls, read/export history, or write Session events | `build/events.md`, `build/sessions.md`, `build/session-operations.md` | `references/events-and-streaming.md` |
| Host an Agent built locally, select its Skills, deploy one Agent per user, or keep one Skill synchronized across a fleet | `build/per-user-agents.md`, `build/skills.md`, `build/agents.md` | `references/deploy-your-agent.md` — follow it in order |
| Upload, version, list, or delete a platform Skill ZIP | `build/skills.md` | `references/skill-registry.md` — check deployment support and the key's write scope |
| Error handling and retries | `reference/errors.md` | the language reference |
| Credentials, message attachments, repository mount, worker queues, cross-Agent Session listing, rollback, or another uncertain capability | Credentials: `security/secure-deployment.md`, `build/mcp.md`. Attachments and repository mount: `build/files.md`. Worker queues: `build/environments.md`. Session listing: `build/session-operations.md`. Rollback: `build/agents.md`. Otherwise `reference/capabilities.md` | `references/not-supported.md` — check before designing |

Read more than one page or reference only when the request genuinely crosses those boundaries. For example,
a basic streaming chat needs the language reference plus events; it does not need the deployment or
capability-boundary documents.

## Choose the path

| The user has | Give them |
|---|---|
| No API key or no running Agent | The setup flow below |
| A key and wants a chat UI | The official SDK on their backend, relaying the Session stream to their UI; follow `references/deploy-your-agent.md` Step 9 |
| An empty directory, and wants a runnable chat app or demo for one Agent | Offer the starter once (below); if they decline, the official SDK |
| Their own backend, UI, or Agent design | The official SDK |
| A local persona and Skills that need hosted execution | `references/deploy-your-agent.md` |

Build the UI in the user's own stack. The backend holds `ZOOWORK_API_KEY`, authorizes each
end user, and re-emits Session events to the browser.

### Offering the starter

`starter/` in <https://github.com/SerendipityOneInc/zoowork-platform-quickstarts> is an official,
general-purpose chat app for one Agent with the Session plumbing already done. Its trade-off is a
fixed stack (Next.js) and structure.

Mention it once, before writing code, only when all of these hold: the user wants a runnable chat
app or demo, the working directory has no existing project, and the session is interactive. Let the
user choose. If they accept, follow the starter's README for its commands and configuration instead
of this file. If they decline, already have a project, or only want code, build with the SDK in
their own stack and do not bring the starter up again.

## API key onboarding

Create a Project API key at <https://platform.zoowork.ai>. Agent and Session access is scoped
to the selected Project. The secret is shown once; have the user save it in `ZOOWORK_API_KEY`
themselves. Keep it on their backend, outside browser/mobile code, logs and chat.

Initialize Organization billing and bind owner credentials. If the API requests rebinding,
sign in to Platform and rebind the key. `listModels()` / `list_models()` is a cheap read-only
credential check; it does not prove runtime readiness or authorize a billable test.

## Minimal lifecycle

Use this order:

1. List models and select the platform's primary chat default: the row whose `selectable` value
   is not `false` and whose `default_for` includes `model`. Persist that explicit choice.
2. Create the Agent once with a stable idempotency key.
3. Persist `agent_id`.
4. Start the Agent and wait for `desired_state` with the SDK helper.
5. Create one Session per conversation.
6. Post later turns into the same Session and resume streaming from the last processed cursor.

Do not create an Agent inside the function that answers every user message. Each Agent owns a
persistent workspace and sandbox.

```ts
import {
  assistantText,
  createZooworkClient,
  isRunFinished,
  runOutcome,
} from '@zoowork-ai/sdk'

const zc = createZooworkClient()
const models = await zc.listModels()
const model = models.find(
  (row) => row.selectable !== false && row.default_for?.includes('model'),
)?.model
if (!model) throw new Error('No selectable default ZooWork model')

const created = await zc.createAgent(
  { resource: { name: 'support-agent', model: { primary: model } } },
  'support-agent-v1',
)
const agentId = created.agent_id
await zc.startAgent(agentId)
await zc.waitUntilRunning(agentId)

const session = await zc.createSession(agentId, {
  initial_events: [{ type: 'user.message', content: 'Hello' }],
})

let cursor: string | undefined
for await (const event of zc.streamEvents(agentId, session.session_id)) {
  cursor = event.cursor ?? cursor
  process.stdout.write(assistantText(event))
  if (isRunFinished(event)) {
    if (runOutcome(event) !== 'succeeded') throw new Error(`run ${runOutcome(event)}`)
    break
  }
}
```

For Python, use the same lifecycle with `create_zoowork_client`, `list_models`, `create_agent`,
`start_agent`, `wait_until_running`, `create_session`, `stream_events`, `assistant_text`, and
`is_run_finished`. Read `references/python-sdk.md` before writing the exact call shapes; nested
payloads retain public wire spelling where documented.

## Session and event rules

- The event log contains user inputs, assistant replies, tool activity, and run completion.
- Resume every subsequent turn with the last processed event's opaque `cursor`; do not derive
  it from `seq`. Without a cursor the stream replays old turns. REST events and send receipts
  have no cursor, and the final REST continuation is null. There is no current-tail helper.
- Checkpoint only after processing the event. Cursor resume does not make application side effects
  exactly-once.
- `listEvents()` returns one page and drops pagination metadata. Use `listAllEvents()` for the full
  history or `listEventsPage()` for explicit cursor pagination.
- `toolCall().phase` is `start`, `end`, or `blocked`. `blocked` ends a call without execution; no
  `end` follows. Reasons include policy denial, approval denial/timeout/cancellation, or
  interruption; inspect the raw event payload's `deniedReason`. Approval waiting is
  `agent.approval` / `requested`.
- A failed tool call does not necessarily fail the run. `runOutcome()` is the authority.
- Retried writes should use a stable `idempotency_key`.
- A valid `user.interrupt` with no active run can return `accepted: false`; that is a normal no-op.
- `actor: { ref }` selects memory attribution. It is not authentication, authorization, or sandbox
  isolation; derive it from authenticated backend state.

Application-executed custom tools pause the current run until the user's backend resolves them.
They are not MCP tools and not a worker-registration API. Read both the language reference and the
events reference before implementing recovery.

## Platform Skills

A ZooWork platform Skill is attached to a running Agent. It is different from this coding-agent
skill, which teaches a developer's assistant how to call ZooWork.

- New Agents receive global Skills by default. Set `include_global_skills: false` or pass
  `skills: []` to opt out.
- Every create-time `skills` entry needs `skill_id` (a `name`-only entry returns 400) and stays on
  the version resolved at creation, even with `version: 'latest'`. Do not add `name` to an entry:
  it makes the list the Agent's exact Skill set, drops global Skills even with
  `include_global_skills: true`, and makes later assignment calls return `409 source_owned_skills`.
- To add a Skill that should follow new versions, create the Agent without it, then assign it
  with no version pin. To replace one global Skill, assign it with `enabled: false`. Inspect
  `listAgentSkills` / `list_agent_skills` to see the resolved set.
- The source-reviewed Skill registry contract permits named Project keys to write `project`
  Skills and Default Project keys to write `org` Skills. Read `references/skill-registry.md`
  for upload, versioning, write permissions, SDK compatibility, and deployment verification.
- Project keys do not administer root Environments. They bind Channels with one connection per
  platform on each Agent (`account` omitted or `default`); read the SDK reference's Channels section.
- Use `persona.docs` for standing instructions and Session messages for text task inputs.
  To give the Agent a local file, upload it into `/workspace` and name its path in the message.
  Ask the Agent to create and publish output, then download it through the Artifact API.
  Read `references/developer-api.md` for these flows. A workspace file is not a registered
  Skill, and Skill ZIP publishing is a separate registry flow, not task input.
- Prove runtime behavior with an authorized real turn; attachment state alone does not prove use.

Follow `references/deploy-your-agent.md` for packaging, versioning, attachment verification,
per-user isolation, scheduling, UI wiring, and teardown.

## Capability and evidence boundary

“The SDK has no helper” and “the platform has no public contract” are different claims. Before
saying a feature is absent, inspect the installed SDK, public docs, `references/developer-api.md`, and `references/not-supported.md`.
A method in SDK declarations proves its signature, not that its endpoint works in production.
Send input files with the upload flow in `references/developer-api.md` and retrieve outputs as
Artifacts. Do not call the workspace Files methods (`writeWorkspaceFile`, `getWorkspaceFile`,
`getWorkspaceFileContent`, and their Python equivalents): the hosted service does not enable
those routes and the calls fail with HTTP 501 or 502.

Use these evidence labels:

- **Live-verified:** exercised against a named deployment.
- **Source-reviewed:** confirmed in public SDK source or declarations.
- **Offline-tested:** covered by fixtures or unit tests without a live tenant.
- **Unknown:** evidence is insufficient; do not invent a method or route.

Do not run live, billable, or tenant-mutating calls merely to answer a design question.

## Common pitfalls

- Set reasoning through `model.thinking`, not provider fields such as `reasoning_effort`. Agent `null` clears the declaration; Schedule `payload.thinking: null` clears only its override. Read `references/thinking-levels.md` before choosing a level.
- Wait on `desired_state`, never `actual_state`. `actual_state` reports `active` for an enabled
  Agent with a rendered config; it is not channel health or execution readiness, and
  `status.channels` counts are fixed placeholders. The optional `agent_desired_state` and
  `computer_desired_state` fields show the two switches behind `desired_state`.
- Platform uses a managed Environment. Project keys do not administer root Environments.
- `createAgent` and `getAgent` return different shapes.
- Agent updates accept optional positive `expected_config_version` for an atomic precondition.
  Read the current version, then send it at the update body's top level. A mismatch is
  `409 active_config_changed`: re-read and recompute before retrying. Omit it for last-write-wins.
- MCP exposure, runtime context, and permission policy are separate controls.
- Tool-policy wildcards allow an exact name, global `*`, or one trailing `prefix*` only.
- A `tool_policy` the runtime cannot parse is rejected with `400 invalid_request` on every write
  that renders the Agent config, including create and update: an `argsPattern`/`resultPattern`
  that is not RE2 (no lookaround, backreferences or inline flags; at most 512 characters), an
  unknown action, a rule without `id`, non-array `rules`, more than 64 rules, or more than 32 KiB.
  The message names the field. A stored policy that fails keeps later writes failing until an
  update sends a corrected full `tool_policy`.
- Choose tool approvals for the workflow; do not copy `exec: 'always_ask'` as a universal
  deployment default. Read `references/tool-permissions.md` for unattended jobs, repeated calls,
  command-duration limits, and usage after denial. Keep review for actions that need it.
- To review persona changes, set `tool_policy.permissions.persona_doc_update` to `always_ask`.
  Deny `cron` unless the Agent must manage its own schedules. An `allow-always` decision on a
  server-wide MCP default can cover its other tools for the rest of the Session.
- Treat web pages, files and MCP or custom tool results as untrusted input that can carry prompt
  injection; limit tools and require approvals instead of relying on the model to ignore it.
  Artifact download URLs work for anyone who holds them; keep them out of logs.
- There is no public credential store for an end user's secret.
- Match `ZooworkError.status` and `.type`, not message text. Usage validation can return 422
  with no business type; invalid timezone can return 400 `usage.invalid_query`.
- `409 database_conflict` means the request lost a lock conflict and earlier steps may have been
  applied. Re-read the resource, then decide whether to retry. `startAgent` can return
  `409 runtime_credential_unavailable` when the Agent's runtime credential is missing or revoked;
  Project keys cannot repair credentials, so do not loop on start.
- An `Idempotency-Key` replays the first response for at least 7 days on Agent creation and at
  least 24 hours on Session creation, webhook writes and other keyed writes. After that, the same
  key runs as a new request, so a late Agent-create retry can make a second Agent.
- A cross-tenant or unknown identifier can return 404 rather than 403. Repeated Agent deletion
  also returns 404 after the first 204; treat it as cleanup complete only for your known Agent
  with unchanged key scope.
- The production Database viewer is unavailable. Do not call its SDK helpers or HTTP routes.
  Ask the Agent to query via `agent_db` and return results or publish an Artifact.
- A manual Schedule trigger requires `enabled: true`, which also enables automatic firings.
  Disabled triggers may acknowledge `triggered: true` but are skipped; this is not a test mode.
- Create Agents one at a time within an Organization. Concurrent `createAgent` calls with the same
  key can fail with `503 platform.runtime_credentials_unavailable`; no Agent is created, so retry
  with backoff and the same idempotency key.
- For raw HTTP, use the SDK, `curl`, `requests` or `httpx`. The public edge rejects Python's
  default `urllib` User-Agent (`Python-urllib/...`) with `403` and the body `error code: 1010`.
  That is not an API-key error; set an explicit `User-Agent` header if you must use `urllib`.
- `exec(agentId, args)` takes argv. A non-zero process exit can still be HTTP 200.
- `stopAgent` cancels running work and blocks new Sessions and turns; it does not destroy the
  sandbox. Schedules stay defined, and each fire is skipped with reason `runtime_stopped` while
  the Agent is stopped. To remove a throwaway Agent, delete its schedules, call `stopAgent`, then
  `deleteAgent`; deletion does not remove schedules. If the stop fails, read `getAgent` and retry
  the stop before deleting; a deleted Agent cannot be stopped later.
- Do not mix TypeScript camelCase with Python snake_case. Treat identifiers, cursors, and unknown
  response fields as opaque.

Public developer documentation is at <https://zoowork.ai/docs/>. For machine reading, use
<https://zoowork.ai/docs/llms.txt> (an index of per-page Markdown) or
<https://zoowork.ai/docs/llms-full.txt> (every page in one file).
