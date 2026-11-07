# Choose tool permissions for the workflow

Read the public [Permission policies](https://zoowork.ai/docs/en/build/permissions.md) and
[Secure your deployment](https://zoowork.ai/docs/en/security/secure-deployment.md) pages before
configuring approvals. Verify the installed SDK declarations for exact call shapes. This
reference is integration guidance, not a new permission mode.

## Decide which calls need review

- Use `always_ask` when the application must authorize a call or a person must review it,
  including changes to external systems or spending that has not been authorized for
  autonomous execution. Keep that review even when the workflow runs in the background.
- Use `always_allow` for tools the developer has explicitly authorized to run without further
  review. Narrow the tool set and check what those tools can reach first. Running inside a
  sandbox does not prevent an `exec` command from making external requests or incurring costs.
- If a reviewer authorizes a matching scope for the rest of a Session, use `allow-always`
  only when it is in the approval record's `allowed_decisions`. A server-wide MCP scope can
  cover other tools on that server. This does not change the Agent's stored policy.

Do not add `exec: 'always_ask'` merely because a deployment example shows it. Conversely, do
not remove a required approval just to make a task finish. ZooWork supports `always_ask`
and `always_allow`; do not copy another platform's `auto` value.

## Keep unattended work able to make progress

An unanswered approval is denied after ten minutes. Without a matching Session grant, each
matching call requires a decision, including repeated `process` polling and a later
`artifact_publish` call. A handler that only answers the first request is insufficient.
If a decision cannot be obtained, interrupt the run rather than leaving required review
unattended. Automatically allowing every request adds no review over `always_allow` and
makes progress depend on every response arriving in time.

## Separate approval time from command time

The ten-minute deadline is the time to answer an approval, not a 600-second maximum for
commands. An in-loop `exec` call's `timeout` controls execution after approval. The direct
SDK `exec(agentId, argv)` method is a separate operation; do not substitute its arguments
or timeout contract for the Agent tool's.

If the application enforces a command-duration limit, include that limit in task or persona
instructions so the Agent can select suitable arguments. Continue enforcing it in the
application; model instructions are not an authorization boundary. Do not infer that a
customer's duration limit came from the approval deadline without evidence.

## Explain usage and check the result

Model requests can occur before a tool is proposed and after it is denied. Reading Skill
instructions, planning a command, checking progress, and explaining a denial can incur model
usage even if no Artifact is produced. A denial stops that tool call; it does not refund
model usage that has already occurred. Use the Session's Usage records and events to
explain the work performed instead of assuming that no output means no cost.

A successful run means the turn ended normally, not that every requested tool executed or
that the business task produced its required output. Inspect blocked/error tool events and
verify the expected Artifact or result separately. Do not promise a refund or compensation
policy on the basis of a tool denial.
