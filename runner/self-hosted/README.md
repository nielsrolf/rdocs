# Self-hosted runner worker (NOT BUILT YET)

This is a stub. There is no docker image here yet — this document specifies
the interface an external worker needs to implement so a document can be
flagged `runnerMode: "selfHosted"` and have its agent jobs execute on the
user's own infrastructure instead of this app's container runner.

## What the app does today for a `selfHosted` document

- It does **not** clone or maintain a git worktree for the document at all
  (contrast with `runnerMode: "managed"`, where `lib/research-workspace.ts`
  bind-mounts `.research-workspaces/<documentId>/worktrees/...`).
- When a run starts (AI edit / conversation / comment reply), it creates a
  `SelfHostedJob` row (`prisma/schema.prisma`) instead, containing the
  serialized `AgentJob` (`input` + `agentConfig` + `agentEnv` + validation
  spec — see `lib/agent-runner/index.ts`'s `toAgentJob`).
- It polls that row for a result (`lib/agent-runner/self-hosted.ts`,
  `SelfHostedPullRunner`) for up to 6 hours before giving up.

## What a worker must do

1. Mint a token: in a document you own, open document settings → "Self-hosted
   setup" → mint a token (`POST /api/user/self-hosted-tokens`, same
   underlying `gdai_…` bearer token as "Connect via MCP"). Shown once.

2. Poll for work:

   ```
   POST <APP_URL>/api/self-hosted/jobs/claim
   Authorization: Bearer gdai_...
   ```

   Returns `{ "job": null }` (nothing pending — poll again later) or:

   ```json
   {
     "job": {
       "id": "...",
       "documentId": "...",
       "aiRunId": "...",
       "jobPayload": { "input": { ... }, "agentConfig": { ... }, "agentEnv": { ... }, "validation": { ... } }
     }
   }
   ```

3. Do the work, in your OWN clone of whatever repo the document is linked to
   (this app has no opinion on how — clone it yourself, using whatever git
   credentials you have locally). Run the Claude Agent SDK (or any agent that
   honors `agentConfig`/`agentEnv`/the validation spec) against `jobPayload`.

4. Report the result:

   ```
   POST <APP_URL>/api/self-hosted/jobs/<id>/result
   Authorization: Bearer gdai_...
   Content-Type: application/json

   { "result": { "replacementText": "...", "summary": "...", ... } }
   ```

   or on failure:

   ```json
   { "error": "human-readable failure message" }
   ```

   The `result` shape is `ClaudeResearchAgentOutput` (`agent-core/agent.ts`).

## Explicitly NOT implemented yet

- **No prebuilt docker image.** This README describes the HTTP contract only;
  someone still needs to write the worker loop (steps 2-4 above) and package
  it. A reasonable starting point: copy `runner/Dockerfile.agent` and
  `agent-core/` as the execution engine, replace the container-runner's
  stdin/NDJSON transport with the claim/result HTTP calls above.
- **No progress streaming.** The app has no live view into a self-hosted run
  until it finishes — no equivalent of the container runner's NDJSON
  progress frames yet. The agent panel will just show "waiting" until the
  worker posts a final result.
- **No cancellation propagation.** Stopping a run in the UI stops the app's
  poll loop and marks the run cancelled, but does not tell the worker to stop
  executing.
- **No merge-conflict auto-resolution** for self-hosted documents
  (`SelfHostedPullRunner.resolveMergeConflicts` throws). The owner's worker
  would need to handle merges itself, or this needs a dedicated job type.
