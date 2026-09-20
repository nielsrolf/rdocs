# External orchestrators

`scripts/run-agent-job.ts` provides a generic standalone interface to the same
`ContainerRunner` used by r-docs. It accepts one JSON `AgentJob` on stdin, plus
optional `containerName` and `timeoutSeconds`, and emits NDJSON progress, session,
result and error frames on stdout. Runner diagnostic lines may also occur on
stdout; consumers should ignore non-JSON lines or record them as diagnostics.

Run with `node_modules/.bin/tsx scripts/run-agent-job.ts` from the r-docs checkout.
The caller supplies an isolated `input.workspacePath`, `agentConfig`, and explicit
`agentEnv` credentials. The caller owns queueing, state, workspaces and accounting.
No r-docs documents or AiRun rows are created; attached containers are used and
SIGTERM/SIGINT abort the run. The default timeout is one hour, maximum one day.
Use the installed Claude/Codex container images and a process with Docker access.

For normal r-docs runs using the credential broker, the broker now records passive
`[usage]` system events in `AiRunEvent`. Each event contains a generated request id,
provider/model, input/output/cache token counts, an upstream cost header when
available, and a completeness flag. The existing run-detail API exposes these
events. A missing cost is **null**, not zero. These events do not implement budget
enforcement and do not cover direct/subscription requests outside the broker.
Streaming responses remain streamed; cancellation records incomplete usage.

The separate ML Research Bench service is one caller. Its gateway implements
run-scoped credentials, reservations and frozen prices without adding evaluation
policy to r-docs itself.
