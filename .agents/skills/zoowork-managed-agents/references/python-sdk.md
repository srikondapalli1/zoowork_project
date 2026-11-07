# Python SDK surface

The official package is `zoowork`. It requires Python 3.11+ (zoowork 0.9.0+; older releases
supported 3.10), is asynchronous, uses `httpx`, and keeps public request and response fields in
their wire spelling. Client methods and event helpers use snake_case. Do not mechanically
translate payload keys: `custom_tools`, `input_schema`, and `pending_custom_tool_calls` are
snake_case, while the declared timeout remains `timeoutMs` because that is the public wire field.

The package exports `create_zoowork_client`, `ZooworkClient`, `ZooworkError`, page and custom-tool
types, `SessionEvent`, `ToolCall`, `CustomToolUse`, the two event vocabularies, event helpers, and
`parse_sse`. Unknown response fields and event types are preserved.

## Construction and lifecycle

```python
from zoowork import create_zoowork_client

async with create_zoowork_client() as client:
    models = await client.list_models()
    model = next(
        (
            row["model"]
            for row in models
            if row.get("selectable") is not False and "model" in (row.get("default_for") or [])
        ),
        None,
    )
    if model is None:
        raise RuntimeError("no selectable default ZooWork model")
```

`create_zoowork_client()` reads `ZOOWORK_API_KEY` and `ZOOWORK_BASE_URL`. You may instead pass the
key as the first argument and `base_url=` explicitly. The default base already ends in
`/service/v1`; do not append another version segment. Keep the Platform Project key on a
backend, never in browser or mobile code.

The mandatory lifecycle is:

```python
agent = await client.create_agent(
    {
        "name": "support-agent",
        "model": {"primary": model},
        "userTimezone": "Asia/Shanghai",
    },
    idempotency_key="support-agent-v1",
)
agent_id = agent["agent_id"]
await client.start_agent(agent_id)
await client.wait_until_running(agent_id)
session = await client.create_session(
    agent_id,
    {"initial_events": [{"type": "user.message", "content": "Hello"}]},
)
```

`create_agent()` takes the resource dictionary directly. This differs from TypeScript, whose
method takes `{ resource }`. Every Session method still takes `agent_id` first. Create an Agent
once and persist its id; create a Session for each conversation. For a temporary Agent, put cleanup
in `finally` while the SDK client is still open: remove its schedules, call
`stop_agent(agent_id)`, then `delete_agent(agent_id)`. If stopping fails, read `get_agent` and
retry the stop before deleting; a deleted Agent can no longer be stopped through the API.

Do not choose the first model row blindly. `list_models()` can include lifecycle rows whose
`selectable` value is false so existing Agents can continue to reference them. A new selection is
rejected with `409 model_not_selectable`; refresh the catalog and use `expired_fallback_to` when
present. For the primary chat default, use the selectable row whose `default_for` includes
`model`, as above. `userTimezone` is the wire spelling for the Agent's named IANA timezone; it affects prompt
context and message timestamps, not Schedule timezone.

## Thinking settings

`ThinkingLevel = Literal["off", "low", "medium", "high", "max"]` is exported by `zoowork`.
Use `model.thinking` in `create_agent` or `update_agent`, and `payload.thinking` on a
Schedule's `agentTurn`. Python `None` serializes to JSON `null`; it clears the Agent declaration
or Schedule override. Read [Thinking levels](./thinking-levels.md) for examples, model
capabilities, precedence and update compatibility.

## Events

```python
from zoowork import assistant_text, is_run_finished, run_outcome

cursor: str | None = None
async for event in client.stream_events(agent_id, session["session_id"]):
    cursor = event.cursor or cursor
    print(assistant_text(event), end="")
    if is_run_finished(event):
        if run_outcome(event) != "succeeded":
            raise RuntimeError(run_outcome(event))
        break
```

The stream is Session-scoped and does not close at turn end. Break on `is_run_finished()`. Resume
by passing `cursor=cursor`; the cursor is opaque. `list_events()` returns one page,
`list_events_page()` keeps `has_more` and `next_cursor`, and `list_all_events()` follows pagination
for you. From 0.8.0, `list_all_events(agent_id, session_id, cursor=saved)` starts the walk after a
saved cursor and never falls back to the `after` lane. The normalized event uses
`event.event_type`, `event.run_id`, `event.processed_at`, and `event.created_at`.

Each of `list_events`, `list_events_page`, `list_all_events` and `stream_events` also has a
deprecated `after=` overload, which type checkers flag from 0.8.0. It reads the engine-only lane,
whose numbering differs from `event.seq` and which omits your inputs, so `after=event.seq`
silently skips and renumbers events. Use `cursor`. Passing both `cursor` and `after` does not
type-check; `list_all_events` raises `TypeError` before any request, and the server rejects the
combination on the other methods with `400 invalid_request`.

Five write-side types exist: `user.message`, `user.interrupt`, `user.tool_confirmation`,
`user.custom_tool_result`, and `system.message`. Give retryable events a stable
`idempotency_key`. A successful `user.interrupt` when nothing runs can return
`accepted: false`; that is a normal no-op, not an exception.

For a follow-up, reuse the same Session and stream from the last processed cursor:

```python
receipts = await client.post_events(agent_id, session["session_id"], [{
    "type": "user.message", "content": "Continue with the same task.",
    "idempotency_key": "task-followup-1",
}])
if len(receipts) != 1 or receipts[0].get("accepted") is not True:
    raise RuntimeError("Follow-up was not accepted")
```

`post_events()` returns a list of per-event receipt dictionaries, not an object with an
`events` field. Check acceptance before resuming `stream_events(..., cursor=cursor)`.

## Filtered Session pages

`list_sessions(agent_id, page=...)` preserves the legacy fixed-50 numeric page lane. Use the
separate cursor method for filters and resumable scans:

```python
cursor: str | None = "sls1:0"
while cursor is not None:
    page = await client.list_session_page(
        agent_id,
        cursor=cursor,
        limit=100,
        runtime_modes=["active"],
        include_archived=False,
        include_deleted=True,
    )
    for row in page.sessions:
        await index(row)
    cursor = page.next_cursor
```

Sessions created through the API have `channel: "api"`, so `exclude_channels=["api"]` omits all of
them. Pass it only when you intend to scan non-API Sessions:

```python
page = await client.list_session_page(
    agent_id, cursor="sls1:0", exclude_channels=["api"], runtime_modes=["active"],
)
```

`limit` is 1–100. Runtime modes are `active`, `preview`, `authoring`, and `evaluation`. The cursor
is bound to the Agent and exact filter scope, so keep filters unchanged; invalid reuse returns
`400 invalid_cursor`. Each row can include `list_cursor` for resuming after a partially consumed
page. `get_session()` and list rows can include `pending_approvals` and
`pending_custom_tool_calls`; both are counts.

Deleted Sessions are omitted by default. `include_deleted=True` adds tombstone rows with
`deleted: true`, and `page.includes_deleted` confirms that mode. The option is part of the cursor
scope and must stay unchanged while continuing. A tombstone is not a readable Session resource.

## Application-executed custom tools

Declare up to 32 tools on the Agent resource:

```python
agent = await client.create_agent(
    {
        "name": "pricing-agent",
        "custom_tools": [
            {
                "name": "lookup_price",
                "description": "Look up one SKU.",
                "input_schema": {
                    "type": "object",
                    "properties": {"sku": {"type": "string"}},
                    "required": ["sku"],
                },
                "timeoutMs": 600_000,
            }
        ],
    }
)
```

Names match `[A-Za-z0-9_-]{1,64}` and cannot shadow built-in, MCP, memory, or runtime-reserved
tools. Descriptions are non-empty and at most 4 KiB; the object schema is at most 16 KiB;
`timeoutMs` defaults to 600,000 and caps at 86,400,000 ms.

Handle and resolve the request in the application:

```python
from zoowork import custom_tool_use

call = custom_tool_use(event)
if call is not None and call.phase == "requested":
    result = await pricing.lookup(call.input["sku"] if call.input else None)
    await client.resolve_custom_tool_call(
        agent_id,
        call.call_id,
        content=[{"type": "json", "value": result}],
        resolved_by="pricing-service",
    )
```

`list_custom_tool_calls(agent_id, status="pending")` recovers outstanding calls. Result content is
1–16 text, JSON, or base64 image blocks; accepted image media types are PNG, JPEG, GIF, and WebP.
The event alternative is `user.custom_tool_result`, using `custom_tool_use_id` or `call_id`,
`content`, optional `is_error`, and a stable `idempotency_key`.

While waiting, the Session's `run_status` is `awaiting_approval`; inspect
`pending_custom_tool_calls` to distinguish custom work from human approval. A REST resolution may
return `202` and `signaled: true` while the row remains pending until the run consumes it. Terminal
calls return `200` with `signaled: false`. This lifecycle was verified with the published Python
SDK in production on 2026-10-03.

## Agent configuration, MCP, and channels

Agent resource dictionaries accept `userTimezone`, `model`, `persona`, `skills`,
`include_global_skills`, `labels`, `tool_policy`, `mcp`,
`custom_tools`, `system_prompt`, `outcome`, `sandbox`, `environment_id`, and
`environment_version`. `update_agent(agent_id, sections)` updates declared sections. Preserve the
same contract cautions as TypeScript: `tool_policy` and array-valued sections replace their
values; `config_version` increments but is not a rollback handle.

`include_global_skills` defaults to true. False disables automatic global Skills without removing
explicit installs and persists across updates and rerenders. An empty `skills` list at create also
opts out. Each create-time `skills` entry needs `skill_id` and stays on the version resolved at
creation; an entry with `name` makes the list the exact Skill set (no global Skills, later
assignments return `409 source_owned_skills`).

MCP `context.meta` and `context.headers` explicitly opt runtime identifiers into calls; they are
not authentication. `permission` sets `always_ask` or `always_allow` for the server, and `tools`
overrides exact native tool names, with no wildcard and a maximum of 64 entries. Tool-policy
selectors separately support an exact name, global `*`, or one trailing `prefix*`.

Project keys cannot administer root Environments. They can bind Channels with
`start_channel_setup` / `wait_for_channel_setup` (`feishu`, `wecom`, `weixin`) or `add_channel`
(app credentials); each Agent has one connection per platform, so omit `account` or pass
`"default"`. Pass `timeout=setup["expires_in"]` to `wait_for_channel_setup`, whose default is 600
seconds. The rules match the TypeScript reference's Channels section. Skill registry publishing
is a separate, source-reviewed contract: named Project keys upload with `scope="project"`;
Default Project keys use `scope="org"`. `upload_skill` accepts a string scope. Read
[Skill registry](./skill-registry.md) for packaging, deployment verification, write permissions
and version publishing. Use `list_agent_skills` to inspect resolved attached Skills.
Read `developer-api.md` for sending a file to an Agent, text task inputs, file outputs, Database availability, Usage, Organization balance, Run Output,
action detail/paging and Agent webhook management. Check installed source before using new methods.

## Method groups

- Agent lifecycle, filtered Session listing, events, custom tools, approvals, schedules,
  artifacts, system prompts, `wake` and `exec` use Python snake_case names.
- Session create input accepts `runtime_mode: "active"` and `idle_compaction` alongside initial
  events and metadata. Explicit active pins the configuration at creation; omission resolves
  active configuration on later turns.
- `update_agent` accepts top-level positive `expected_config_version` in its sections mapping.
  Read it with `(agent.get("status") or {}).get("config_version") or agent.get("config_version")`.
  The check and write are atomic; stale versions raise status 409, type `active_config_changed`,
  without changing configuration. Re-read and recompute before retrying. The precondition is
  not stored in `declared`; omission keeps last-write-wins updates. `upgrade_system_prompt`
  instead requires its precondition and reports `409 config_version_changed`.
- MCP exact tool overrides accept `requireConfirmation` as true, false or omitted. True requires `permission: "always_ask"` and offers allow-once or deny. Runtime
  context does not authenticate the caller.

## Errors

Every non-success response raises `ZooworkError`. Match `error.status` and `error.type`, never its
message. It also preserves `content_type`, `body_snippet`, `cf_ray`, `request_id`, and
`retryable`. Always close the async client, preferably through `async with`.

Repeated `delete_agent` returns 404 after the first 204. For cleanup, only treat that as absence
for a known Agent under unchanged key scope; inaccessible resources also return 404.

Concurrent `create_agent` calls in one Organization can raise `ZooworkError` with status 503 and
type `platform.runtime_credentials_unavailable`. No Agent was created; create Agents serially and
retry with backoff and the same `idempotency_key`.

`start_agent` can raise status 409 with type `runtime_credential_unavailable` when the Agent's
runtime credential is missing or revoked; Project keys have no route that repairs it, so do not
retry the start in a loop. Status 409 with type `database_conflict` means the request lost a lock
conflict and earlier steps may have been applied: read the resource state before deciding
whether to retry. An `idempotency_key` replays the first response for at least 7 days on
`create_agent` and at least 24 hours on `create_session` and webhook writes; after that, the same
key runs as a new request.
