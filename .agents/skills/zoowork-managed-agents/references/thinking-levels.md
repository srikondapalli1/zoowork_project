# Thinking levels

Use `model.thinking` for an Agent's default and `payload.thinking` for a Schedule's
`agentTurn` override. The public values are `off`, `low`, `medium`, `high`, and `max`.
Provider-specific fields such as `reasoning_effort` are not Agent configuration fields.
Use the TypeScript `ThinkingLevel`, `AgentModelUpdate`, and `AgentUpdate` exports in
`@zoowork-ai/sdk` 0.12.0+, or `ThinkingLevel` in Python `zoowork` 0.7.0+.
Inspect the installed package before importing them; do not upgrade a pinned SDK without
user authorization.

## Choose a level from the catalog

`listModels()` / `list_models()` rows carry `thinking: { default, levels }`.
`levels` lists the levels that produce distinct requests on that model, in ascending order.
`default` is the model default when neither the Agent nor platform sets one; a platform
default or safety override can change the effective level without changing this value.
The response type keeps `thinking` optional, so handle an omitted object rather than
inventing capabilities for an older server.

```ts
const models = await client.listModels()
const info = models.find((row) => row.model === primary && row.selectable !== false)
if (!info?.thinking) throw new Error('This catalog does not report thinking capabilities')
const supported = info.thinking.levels
```

```python
models = await client.list_models()
info = next(row for row in models if row["model"] == primary and row.get("selectable") is not False)
capability = info.get("thinking")
if capability is None:
    raise RuntimeError("This catalog does not report thinking capabilities")
supported = capability["levels"]
```

The service resolves a requested level outside `levels` to the nearest listed one; ties go
up. For a model whose levels omit `off`, requesting `off` selects the lowest available level.
A model may expose only `medium` because its route has no switch, or only `off` because
thinking is unsupported. Read each model's row rather than maintaining a family lookup table.
The actual model used on each call determines this resolution, including Session model
overrides, Auto routing, Schedule model selections and subagents.

## Set and clear the Agent default

At creation, include `thinking` alongside `primary`: TypeScript uses
`{ resource: { name, model: { primary, thinking: 'high' } } }`, while Python passes
`{"name": name, "model": {"primary": primary, "thinking": "high"}}` directly.
For an existing Agent, `primary` is not required in the partial update:

```ts
import type { AgentUpdate } from '@zoowork-ai/sdk'

await client.updateAgent(agentId, {
  model: { thinking: 'high' },
} satisfies AgentUpdate)
await client.updateAgent(agentId, {
  model: { thinking: null },
} satisfies AgentUpdate)
```

```python
from zoowork import ThinkingLevel

level: ThinkingLevel = "high"
await client.update_agent(agent_id, {"model": {"thinking": level}})
await client.update_agent(agent_id, {"model": {"thinking": None}})
```

`updateAgent` still accepts `Record<string, unknown>`; `AgentUpdate` is opt-in typing, not
an automatically enforced method signature. Omission preserves the stored Agent level.
`null` removes `thinking` from declared and rendered config and restores the platform
default; it does not mean `off`. The Agent validator accepts only the five exact level
strings or `null`. Legacy spellings (`xhigh`, `minimal`, `adaptive`), whitespace, and altered
case are invalid here and return `400 invalid_request`.

## Override a Schedule and clear its override

A Schedule's `agentTurn` `payload.thinking` wins over the Agent's level for that Schedule's
turns. Clear it to follow the Agent again, not to skip the Agent and choose a model default.
It has no effect on other payload kinds.

```ts
await client.updateSchedule(agentId, scheduleId, {
  payload: { kind: 'agentTurn', thinking: 'low' },
})
await client.updateSchedule(agentId, scheduleId, {
  payload: { kind: 'agentTurn', thinking: null },
})
```

```python
await client.update_schedule(agent_id, schedule_id, {
    "payload": {"kind": "agentTurn", "thinking": "low"},
})
await client.update_schedule(agent_id, schedule_id, {
    "payload": {"kind": "agentTurn", "thinking": None},
})
```

For Schedule updates, omission or an empty/whitespace-only string preserves the stored value;
`null` clears it. New or changed strings are trimmed and lowercased. `xhigh`, `minimal` and
`adaptive` normalize to `max`, `low` and `medium`. An unchanged stored value is preserved
verbatim, so a historical value round-tripped from GET may keep its legacy spelling.
Other invalid non-null values return `400 invalid_request`. Keep these Schedule
compatibility rules separate from the strict Agent validator.

## Know when it takes effect

Updates create a new Agent config version. Sessions created without `runtime_mode` read the
active version on their next turn; the current turn keeps its old config. An explicit
`runtime_mode: 'active'` pins the version active at creation. `preview` and `evaluation`
pin their specified version. `authoring` reads the `config_version` supplied per turn.
Pinned Sessions do not pick up later Agent changes. Schedules read the active version at
each firing.

The usual priority is Schedule override, Agent default, platform default, then actual-model
default. A platform safety override can win over the entire chain. Reasoning-only output
truncation can cause a one-time retry at a lower level, so the successful reply may describe
the retry rather than the first call. Higher levels generally increase output-token usage
and time before visible text; reasoning tokens are billed as output and consume `max_tokens`.

## Verify without confusing text with settings

Source-reviewed: the five-level contract, update semantics, capability resolution and
config-version behavior above. Public-gateway staging verification must include a catalog
that reports `thinking`; a missing capability object is not a passing test.
Only run billable tests when the user authorizes them. Use isolated temporary resources.
Set a Schedule's next automatic firing well after the test window, enable it for a manual
trigger, then delete it during cleanup; a disabled trigger can acknowledge and skip work.

Read `getSession(agentId, sessionId, { history: true })` / `get_session(..., history=True)`.
Assistant transcript entries can carry `entry.metadata.thinking` with `level`, `requested`,
`forced`, `clamped`, and `truncationRetry`. Check the actual `level` and account for overrides,
clamping and retries. Old entries can omit this metadata. A visible `agent.thinking` text
block, or a successful ordinary reply, does not prove that `high` rather than `medium` was sent.
Do not label a case live-verified until its requests and cleanup succeed on the named deployment.
