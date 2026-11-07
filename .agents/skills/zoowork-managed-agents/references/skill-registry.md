# Platform Skill registry

A platform Skill is a ZIP package containing `SKILL.md` and optional scripts and resources.
Uploading registers a Skill and its first version; attaching it to an Agent is a separate call.
It does not upload arbitrary task files into `/workspace`.

## Availability and SDK compatibility

**Evidence: source-reviewed; Project-key deployment and runtime behavior are not live-verified
by this guide.** The contract below requires a service deployment that supports Project-key
Skill registry requests. Older deployments reject `/skills` for Project keys. Verify the target
deployment before presenting the workflow as usable there; a successful SDK build proves neither
server support nor that an Agent read the Skill.

Inspect the installed TypeScript `uploadSkill` declaration. TypeScript SDK 0.10.2 and later
accept `project`; older SDKs accept only `org | personal`. When the installed declaration includes
`project`, use `uploadSkill(zip, { scope: 'project' })` for a named Project. Otherwise use the
multipart HTTP request below. Do not use `as any` or switch scope. Python's `upload_skill(..., scope: str)` can send `project` without a signature change.
Keep credentials on the backend and reuse the application's client configuration.

## Choose the key's write scope

| Platform key | Create, publish versions, delete |
|---|---|
| Named Project | `project` Skills belonging to that same Project and Organization |
| Default Project | `org` Skills belonging to that Organization; these are Organization-shared |

Create with exactly the matching `scope`. The API derives `org_id` and `project_id` from the key;
do not send caller-selected ownership. A wrong create scope, including `personal` or `global`,
returns `400 service_api.invalid_body`.

Read permission is broader than write permission: global Skills, same-Organization org Skills,
same-Project project Skills, and eligible personal Skills belonging to the key's owner are
visible. A visible global or personal Skill is not writable with a Platform key. Named Project
keys also cannot edit Organization-shared Skills. Inaccessible or non-writable Skill IDs return
`404 service_api.not_found`, including on version publishing and deletion.

## Package and upload

Use one Skill per ZIP. `SKILL.md` must be nonempty and declare `name` and `description` in YAML
frontmatter. Either put it at the archive root or put the Skill in one top-level directory whose
name matches the frontmatter name. Keep the Skill name unchanged when publishing a new version.
Put the description in `SKILL.md`; the separate create-time description option is not forwarded.

For example, `slide-layout/SKILL.md` starts with:

```markdown
---
name: slide-layout
description: Review slide layouts and apply consistent spacing and hierarchy.
---

Read the supplied slides and apply the layout rules in this package.
```

```bash
zip -r slide-layout.zip slide-layout/
```

Use the application's documented public `ZOOWORK_BASE_URL`, including `/service/v1`, and its
server-side `ZOOWORK_API_KEY`. Do not add another version prefix or print the key. This request
creates a resource; execute it only as part of an authorized upload, not as a capability probe.
For a named Project:

```bash
curl --silent --show-error --fail-with-body \
  "${ZOOWORK_BASE_URL%/}/skills" \
  -H "Authorization: Bearer $ZOOWORK_API_KEY" \
  -F 'scope=project' \
  -F 'files[]=@slide-layout.zip;type=application/zip'
```

For a Default Project key, use `-F 'scope=org'` instead. Do not manually set the multipart
`Content-Type`: the HTTP client supplies its boundary. Save the returned `skill_id`.

Python, inside the application's existing async context:

```python
from pathlib import Path

skill = await client.upload_skill(
    Path("slide-layout.zip").read_bytes(),
    scope="project",  # Use "org" for a Default Project key.
    file_name="slide-layout.zip",
)
skill_id = skill["skill_id"]
await client.put_agent_skill(agent_id, skill_id, enabled=True)
assigned = await client.list_agent_skills(agent_id)
```

TypeScript can use `uploadSkill(zip, { scope: 'org' })` for a Default Project key. After a
named-Project HTTP upload, use the returned ID with `putAgentSkill(agentId, skillId,
{ enabled: true })` and inspect `listAgentSkills(agentId)`. The Agent and Skill must be accessible
to the same key. Persist IDs instead of creating a new Skill on every Agent deployment.

An `Idempotency-Key` header is not a replay guarantee for Skill uploads. After an uncertain
create result, reconcile using `listSkills` / `list_skills` and inspect the existing record before
retrying; a duplicate create can return `409 skill_exists`. Listing returns one page, not a
complete registry. Do not treat a first-page miss as proof the create failed.

## Publish a version and verify the Agent

Publish to the existing Skill ID, with the same frontmatter name. Do not repeat root create:

```ts
const version = await zc.uploadSkillVersion(skillId, zip, { fileName: 'slide-layout.zip' })
// This is a version row: version/state, not latest_version/status.
if (version.state !== 'ready') throw new Error(`Skill version is ${version.state}`)
const assigned = await zc.listAgentSkills(agentId)
```

The Python method is `upload_skill_version(skill_id, zip_bytes, file_name="slide-layout.zip")`.
The HTTP equivalent is `POST /skills/{skill_id}/versions` with multipart `files[]`; it does not
select a new scope or transfer ownership. Read and write permissions still differ.

Unpinned bindings follow new versions; pinned bindings keep their selected version. Inspect the
resolved Agent assignment after publishing. An updated `config_version` or successful upload
alone does not prove runtime use. When a real turn is authorized, use a task that needs this Skill,
inspect tool calls for the resolved Skill location, and check the final run outcome. See
[deployment verification](./deploy-your-agent.md#step-6-smoke-test-with-a-real-turn-that-should-use-a-skill).

## Delete

`deleteSkill(skillId)` / `delete_skill(skill_id)` deletes the registry Skill, rather than just
one Agent binding. Use `deleteAgentSkill` / `delete_agent_skill` to detach only one Agent. Check
consumers before deleting a shared org Skill. The same key-scoped write restrictions apply.
