# Self-hosted runner worker

A worker exists now at `runner/self-hosted/worker.ts` (the poll loop) +
`runner/self-hosted/Dockerfile` (packaging). It reuses `agent-core/` — the
same framework-free execution engine `runner/agent-entrypoint.ts` wraps for
the app's own container runner — so the actual Claude Agent SDK loop is
identical to a managed run; only the transport (HTTP claim/result instead of
stdin/NDJSON) and the workspace provisioning differ.

Read "What's built" and "Explicitly NOT implemented yet" below. Repo-backed
documents work: the job payload carries the repo URL/branch (never
credentials) and the worker clones with its own git auth.

## Quick start

```
docker run -d --restart unless-stopped --name rdocs-worker \
  -e APP_URL=https://docs.nielsrolf.com \
  -e SELF_HOSTED_TOKEN=gdai_... \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  nielsrolf/rdocs-worker:latest
```

The image is published multi-arch (amd64 + arm64). Mint the token (and get
this command pre-filled) from **AI credentials** in the topbar or the
document's self-hosted panel. Add `GITHUB_TOKEN` for private-repo documents.

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
- Crucially, `input.workspacePath` in that payload is always `null` for a
  selfHosted job (the app never creates a worktree for these documents), and
  no repo URL/branch/credentials are serialized anywhere else in the payload
  either. `runClaudeResearchAgent` (`agent-core/agent.ts`) refuses to run with
  a null `workspacePath` — some workspace directory MUST exist before the
  agent runs.

## Building and running the worker

```bash
# Build (context is the repo ROOT so agent-core/ can be COPYed):
docker build -f runner/self-hosted/Dockerfile -t gdocs-self-hosted-worker:local .

# Run — doc-only jobs (no repo access), using your own Anthropic credentials:
docker run --rm \
  -e APP_URL=https://docs.nielsrolf.com \
  -e SELF_HOSTED_TOKEN=gdai_... \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  gdocs-self-hosted-worker:local

# Run — with a pre-existing local checkout of the document's linked repo
# available to every job (see the gap note below):
docker run --rm \
  -e APP_URL=https://docs.nielsrolf.com \
  -e SELF_HOSTED_TOKEN=gdai_... \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e GITHUB_TOKEN=ghp_... \
  -v /path/to/your/local/checkout:/repo:ro \
  -e WORKSPACE_REPO_PATH=/repo \
  gdocs-self-hosted-worker:local
```

Env vars the worker reads:

| Var | Required | Purpose |
| --- | --- | --- |
| `APP_URL` | yes | Base URL of the gdocs-ai deployment (no trailing slash needed). |
| `SELF_HOSTED_TOKEN` | yes | The `gdai_…` token minted for your account (document settings → "Self-hosted setup", same underlying `ApiToken` as "Connect via MCP"). |
| `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` | for Anthropic-model docs | Your own credential — `agent-core` reads it straight from `process.env` via the `ANTHROPIC_*`/`CLAUDE_*` prefix allowlist in `agent-core/agent-env.ts`. Not needed for OpenRouter/LiteLLM-model docs (those keys travel in the per-document `agentEnv` the app sends with the job). |
| `GITHUB_TOKEN` | optional | Configured into a global `git config --global url.insteadOf` (mirrors what `runner/agent-entrypoint.ts` does inside the app's container) so plain `git`/`gh` commands authenticate. Only useful together with `WORKSPACE_REPO_PATH` pointing at a checkout with a matching remote. |
| `WORKSPACE_REPO_PATH` | optional | Path (inside the container) to a pre-existing checkout of the document's repo. **Not fetched or selected automatically — see the gap below.** If unset, every job runs against an empty scratch directory. |
| `WORKER_SCRATCH_DIR` | optional | Base dir for the per-job scratch directories (default: the container's `/tmp`). |
| `POLL_INTERVAL_MS` / `POLL_BACKOFF_MAX_MS` | optional | Poll cadence when idle (default 5s, backs off exponentially to 30s on repeated empty claims). |

## What's built

- The poll loop (`claim` → run with `agent-core` → `result`), with exponential
  backoff on empty claims and on transient HTTP errors.
- Doc-only agent turns (`edit_selection` / `comment_reply` / `conversation`
  with no repo dependency) work end-to-end: `docker build` succeeds, and a
  smoke run against an unreachable `APP_URL` confirms the env validation and
  poll/backoff loop behave correctly (verified locally; not exercised against
  a live claim/result round-trip in this change, since that requires a real
  minted token and a pending job).
- `agentConfig`/`agentEnv`/the validation spec are honored exactly as the
  container runner honors them (`buildSubmissionValidator`,
  `runClaudeResearchAgent`) — same code path, so OpenRouter/LiteLLM/local-model
  document configs work the same way they do for managed documents, gated on
  the same per-document env keys.
- `GITHUB_TOKEN` → global git credential helper config, same approach as
  `runner/agent-entrypoint.ts`.
- A single pre-mounted repo checkout (`WORKSPACE_REPO_PATH`) can be used as
  the workspace for every job this worker processes (copied into a fresh
  per-job scratch dir, so a crashed run never dirties your real checkout).

## Now implemented (since the first slice)

- **Automatic repo cloning.** The job payload carries the document's repo
  coordinates (`repo: { url, branch }` — URL and branch only, never
  credentials); the worker clones per job with THIS box's own git
  credentials (`GITHUB_TOKEN` env, or whatever ambient git auth exists).
  `WORKSPACE_REPO_PATH` still overrides cloning when set.
- **Progress streaming.** The worker batches `onProgress` frames and POSTs
  them to `/api/self-hosted/jobs/:id/progress` every ~2.5s; they land in the
  run's timeline, so the agent panel (and Slack) show live progress.
- **Cancellation propagation.** Stopping a run marks the job `cancelled`;
  the worker learns this from the `cancelled: true` flag on its next
  progress post, aborts the SDK loop (subprocess included), and discards the
  result. Late results for cancelled jobs are rejected by the app.
- **Job payloads are encrypted at rest** in the app's database (they carry
  the owner's credentials); they are decrypted only when a worker claims the
  job, over TLS.

## Explicitly NOT implemented yet
- **No merge-conflict auto-resolution** for self-hosted documents
  (`SelfHostedPullRunner.resolveMergeConflicts` throws). The owner's worker
  would need to handle merges itself, or this needs a dedicated job type.
  `runMergeConflictResolver` from `agent-core` is available and importable
  from this worker's `agent-core/` copy if someone wants to wire up a
  `merge_resolve`-shaped job type later, but no such job type exists on the
  app side today for `selfHosted` documents.
- **No sandboxing.** Unlike `Dockerfile.agent` (which exists specifically to
  confine an untrusted per-document run on infrastructure the app operator
  controls), this worker runs with `isolatedRuntime: false` and no OS-level
  boundary beyond whatever the operator's own container/host provides — by
  design, since it runs on the document owner's own trusted infrastructure
  with their own credentials.
- **No concurrency.** The loop processes one job at a time; running multiple
  replicas of this image against the same token is untested (claims are
  atomic server-side per `claimNextSelfHostedJob`, so it should be safe, but
  scratch-dir/workspace collisions with a shared `WORKSPACE_REPO_PATH` have
  not been considered).

## What a worker must implement (the HTTP contract, for reference / for anyone rewriting this in another language)

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
   credentials you have locally; `input.workspacePath` is always `null` here,
   so you must substitute a real directory before running the agent). Run the
   Claude Agent SDK (or any agent that honors `agentConfig`/`agentEnv`/the
   validation spec) against `jobPayload`.

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
