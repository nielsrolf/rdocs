# CLAUDE.md — working on r-docs (repo dir: gdocs-ai)

A Next.js (App Router) + Prisma/SQLite + TipTap app that runs the Claude Agent SDK for document edits, comment replies, and repo work. See `README.md` for the product description.

## Running the app

The service runs via `./gdocs-ai.sh`, which loads `.env`, runs `npm ci`, `prisma generate`, `prisma db push`, `npm run build`, and finally `npm run start` on port `14141`. The currently running PID is stored in `.service.pid`.

You are allowed to manage the service yourself when debugging — restart it whenever a server-side change needs to be live. The standard restart recipe:

```bash
# 1. Start a fresh build+run in the background. Do NOT kill .service.pid
#    yourself — gdocs-ai.sh frees the port itself: it kills any previous
#    listener AND any SIGTERM-surviving old next-server still holding
#    keep-alive connections. (Killing only the pid-file process orphans the
#    next-server child: it keeps serving the OLD build through cloudflared's
#    pinned connections while the new run rebuilds .next under it and then
#    dies with EADDRINUSE — users see ChunkLoadError. This happened for real.)
LOG="logs/service_$(date +%Y%m%d_%H%M%S).log"
nohup ./gdocs-ai.sh > "$LOG" 2>&1 &
echo $! > .service.pid

# 2. Wait for "Ready in" before exercising the API.
until grep -q "Ready in" "$LOG" 2>/dev/null; do sleep 2; done

# 3. Verify exactly one server survived — anything else means a zombie build.
lsof -nP -iTCP:14141 -sTCP:LISTEN; ps aux | grep next-server | grep -v grep
```

The `npm ci` + `npm run build` step typically takes 30–90 seconds, so run the restart in the background (or via Bash `run_in_background`) and poll/monitor the log for `Ready in`. Do not start the dev server (`npm run dev`); production `npm run start` is what the deploy uses.

### Zero-downtime deploys (preferred once bootstrapped)

`./deploy/deploy.sh` is the blue/green deploy path — see `deploy/README.md`. Caddy on `:14141` proxies to app instances on `:14142`/`:14143`; each release builds into its own dist dir (`NEXT_DIST_DIR=.next-blue|green`), and after the upstream switch the old process **drains gracefully**: Slack socket + scheduler stop, in-flight agent runs finish where they started (shared DB + Slack Web API), then it exits. `GET /api/health` reports `{ok, draining, activeRuns, pid, distDir}` (503 while draining); `POST /api/admin/drain` (Bearer `DEPLOY_SECRET` from `.env`) starts a drain. The boot sweep in `instrumentation.ts` is **silence-based** (`sweepAbandonedAiRuns`) — never revert it to "fail every RUNNING run at boot", or a new process kills the draining sibling's runs. Migrations must be expand/contract (old code serves the new schema during overlap). `gdocs-ai.sh` stays as the legacy/emergency single-process path; never run both at once — stop Caddy (`kill $(cat .lb.pid)`) and both colors before falling back.

- Public URL: `https://docs.nielsrolf.com`
- Local: `http://localhost:14141`
- The app sits **behind Cloudflare**, which terminates origin connections at ~100s (HTTP 524). Anything synchronous that takes longer than that will fail client-side even if the origin completes.

## Where logs live

Service stdout/stderr is captured in `logs/service_YYYYMMDD_HHMMSS.log`. There is one file per restart. The most recent one is what you want — `ls -lt logs/ | head -3`.

Two log streams converge here:

1. **Server-side `console.log` / `console.warn` / `console.error`** from API routes and `lib/`. Search-friendly prefixes:
   - `[ai-edit] finished {...}` — every AI selection edit run. JSON has `aiRunId`, `documentId`, lengths, `replacementIsEmpty`, `replacementEqualsSelection`, `fallbackFired`, image/widget counts, commit info, model.
   - `[ai-edit] suspect {...}` — same payload, logged at warn level when the agent submitted empty or unchanged replacement text.
   - `[client-log:<level>] {...}` — every event the browser POSTs to `/api/client-log`. Includes `scope`, `userId`, `message`, `data`.

2. **Client-side events**. The browser does not write the service log directly — it POSTs to `/api/client-log`, which `console`s the payload with the `[client-log:…]` prefix. Helper: `logClientEvent({ scope, level, message, data })` in `components/document-workspace/utils.ts`. Every `setGlobalError` in `components/document-workspace.tsx` goes through `reportClientError(message, scope, data?)`, which both shows the toast and logs.

### Useful grep patterns

```bash
# Latest log file
LOG=$(ls -t logs/service_*.log | head -1)

# All AI edit summaries
grep "\[ai-edit\]" "$LOG"

# All client errors
grep "\[client-log:error\]" "$LOG"

# Everything about one document
grep "<documentId>" "$LOG"

# Everything about one AI run
grep "<aiRunId>" "$LOG"
```

`aiRunId` is the strongest correlation key — it threads through the server `[ai-edit]` line, the client `[client-log]` payloads, and the `AiRun` / `AiRunEvent` / `DocumentVersion` tables.

## Debugging: which surface failed?

When something looks broken, ask "did the server finish?" before "did the agent get it right?". The three layers each fail differently:

| Symptom | Where to look |
| --- | --- |
| User sees toast "AI edit failed." with `status:524` and `elapsedMs ≈ 100-130s` | Cloudflare timeout. Check the same `[ai-edit] finished` line later in the log — the agent very likely succeeded but the response was killed in flight. |
| `[client-log:error] scope:ai-edit-marker-lost` | The `aiEditRange` mark covering the selection was wiped before the agent finished (collab step, remote update, doc reset). The payload includes `presence` (plugin state vs. mark state) — that tells you whether the mark or the plugin entry was lost. |
| `[client-log:warn] scope:ai-edit-apply` with `applied:false` or `charDelta:0` | Editor silently rejected the inserted content. Check schema compatibility of what `buildAiEditInsertContent` produced. |
| `[client-log:error] scope:ai-edit-apply-threw` | Exception during `insertContentAt` / `saveDocument` — payload includes stack. |
| `[client-log:error] scope:ai-edit-save-failed` | Editor changed locally but PATCH `/api/documents/:id` did not persist. Compare client docSize vs. server `Document.content`. |
| `[client-log:error] scope:save-document` | Any background autosave failed. |
| `[client-log:error] scope:comment-anchor` | `commentAnchor` mark could not anchor — payload reports `selectedNodeType`, `nodesInRange`. Block-node anchors are stored as `commentThreadIds` attrs on `embeddedWidget` / `repoImage` / `image`; text anchors via the `commentAnchor` inline mark. |
| `[ai-edit] suspect` with `replacementIsEmpty` or `replacementEqualsSelection` | Agent output was a no-op. The `validateSubmission` guard in `app/api/documents/[id]/ai-edit/route.ts` should have caught it and asked the agent to retry — if it didn't, the guard needs widening. |

If the log alone can't answer a question, the database can. Don't query the SQLite file directly — use a one-off Prisma script. Prior tasks have used the pattern below; clean it up when done:

```ts
// scripts/_inspect.ts (gitignored)
import { db } from "../lib/db";

async function main() {
  const run = await db.aiRun.findUnique({
    where: { id: "<aiRunId>" },
    select: { status: true, error: true, startedAt: true, finishedAt: true, instruction: true }
  });
  const events = await db.aiRunEvent.findMany({
    where: { aiRunId: "<aiRunId>" },
    orderBy: { createdAt: "asc" },
    select: { role: true, message: true, createdAt: true }
  });
  const versions = await db.documentVersion.findMany({
    where: { documentId: "<documentId>" },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { id: true, createdAt: true, aiRunId: true, content: true }
  });
  console.log({ run, events, versions });
}

main().finally(() => db.$disconnect());
```

Run with `set -a && . ./.env && set +a && npx tsx scripts/_inspect.ts`. The DB is SQLite at the path in `.env`'s `DATABASE_URL`.

## How the AI edit pipeline fits together

User flow, for context when reading logs:

1. User selects text → `handleAiEdit` in `components/document-workspace.tsx`.
2. Client marks the selection with an `aiEditRange` mark + a plugin-state entry (`upsertAiEditSelection`), keyed by `selectionId`.
3. `POST /api/documents/:id/ai-edit` (`app/api/documents/[id]/ai-edit/route.ts`):
   - Creates the `AiRun` row.
   - Ensures an isolated git worktree under `.research-workspaces/<documentId>/worktrees/...`.
   - Runs the agent via `runClaudeResearchAgent` (`lib/ai.ts`) using the Claude Agent SDK.
   - The agent's only finishing path is the `submit_response` MCP tool, validated by `validateSubmission`.
   - Logs `[ai-edit] finished {...}` regardless of outcome.
   - Returns `replacementText`, `images`, `widgets`, `aiRunId`, etc.
4. Client locates the marker again (`getAiEditSelectionRange(selectionId)` — falls back from plugin state to mark scan), `buildAiEditInsertContent` parses replacement Markdown into TipTap nodes, `insertContentAt` applies it, `saveDocument` PATCHes the new doc back.

Every step is now logged. If you change any of them, keep the `scope` strings stable so historical greps still work.

## MCP bridge (external agents editing documents)

`POST /api/mcp` is a stateless streamable-HTTP MCP server (hand-rolled JSON-RPC in `lib/mcp/server.ts` — initialize / tools/list / tools/call only). Users connect a local Claude Code with the one-liner from the **AI settings page (topbar) → Connect via MCP** button, which mints an `ApiToken` (SHA-256-hashed, `lib/api-tokens.ts`) and copies:

```
claude mcp add --transport http r-docs <APP_URL>/api/mcp --header "Authorization: Bearer gdai_…"
```

Key invariants:

- **All content edits go through the collab step pipeline** (`lib/mcp/apply-edit.ts` → `submitCollaborationSteps`), never a direct content write. Live clients see MCP edits over SSE; stale-version pushes retry up to 3×.
- **Markdown → nodes uses the same pipeline as the browser**: `buildAiEditInsertContent` → markdown-it → `generateJSON` (`@tiptap/html`, in `lib/mcp/markdown-doc.ts`), so `![widget: label](widget://<id>)` placeholders and repo-relative image paths behave identically to built-in agent edits.
- **`upload_files` / `create_widget` write into the document's base workspace** (git-committed under `withWorkspaceLock`, path-traversal-guarded in `lib/mcp/workspace-files.ts`), so `/widgets/<id>/source` and `/repo-files` can serve the artifacts. `create_widget` follows the same host-build policy as the manual `POST /widgets` route.
- Tool schemas are zod (`lib/mcp/tools.ts`), converted with `z.toJSONSchema` for `tools/list`. Tool-level failures (bad `find_text`, missing access) return `isError: true` results so the model can self-correct; only malformed JSON-RPC gets protocol errors.
- Tests: `tests/mcp-server.test.ts` (headless, real SQLite + collab pipeline).

## Bug-fix workflow (required)

When the user reports a bug, **reproduce it first with a new test case that initially fails, then fix it.** Concretely:

1. Write a test that exercises the reported flow and asserts the *correct* behavior. Run it and confirm it **fails** for the reason the user described (a failing test that fails for the wrong reason proves nothing).
2. Only then make the code change.
3. Re-run the test and confirm it now **passes**, and that the rest of the suite stays green.
4. Keep the test — it is the regression guard.

Prefer the cheapest layer that genuinely reproduces the bug: a headless test in `tests/` (real ProseMirror + real SQLite, no browser/LLM) when possible, or the HTTP integration suite (`tests/integration/`, real routes + auth) when the bug needs the request path. See the testable seams already extracted for collab mapping, AI-edit guards, anchor tracking, and widget paths.

## Conventions

- **Don't bypass the agent submission validator.** If the agent regularly trips a check, prefer to fix the prompt or widen the validator (`validateSubmission` in `route.ts`) rather than removing the guard.
- **Don't add new `setGlobalError` calls** in `components/document-workspace.tsx`. Use `reportClientError(message, scope, data?)` so the toast and the log stay in sync.
- **Don't add new `console.log`s on the server without a `[scope]` prefix** — the `logs/` files are searched by prefix.
- **The `AI agent` running edits writes inside `.research-workspaces/<documentId>/worktrees/...`**, never in the r-docs repo itself. `runClaudeResearchAgentOnce` will throw if no isolated workspace is supplied.
- **Schema changes** must be mirrored on both the client TipTap schema (`components/document-workspace/nodes.tsx` + `document-workspace.tsx`) and the server schema (`lib/document-editor-schema.ts` + `lib/document-schema-nodes.ts`). The server schema is used to parse and re-render document content out-of-browser.
- **Tests**: `npm test` runs the headless suite (`tsx --test tests/*.test.ts`); `npm run test:integration` runs the HTTP suite against a running server (`GDOCS_TEST_URL`, default `http://localhost:14141`, skips if unreachable); `npm run test:e2e` runs Playwright. Lint with `npx tsc --noEmit -p .` and `npx next lint`.
- **Models & providers** (`agent-core/agent-config.ts`): `Document.agentModel` stores a canonical Anthropic id (`claude-sonnet-5` default, `claude-fable-5`, `claude-opus-4-8`; legacy rows may still hold the aliases `sonnet`/`opus`, normalized on read), an OpenRouter model as `openrouter/<author>/<model>` (curated list + custom slug in the UI, gated on the document env having `OPENROUTER_API_KEY`), or a LiteLLM model as `litellm/<model-name>` (gated on `LITELLM_API_KEY`; also needs `LITELLM_BASE_URL` — per-doc, or the server-wide default in `.env`, which on this deployment is `http://host.docker.internal:9274`, the host's ssh tunnel to litellm.nielsrolf.com). Both third-party providers use the same Claude Agent SDK pointed at an Anthropic-compatible endpoint: `applyProviderEnv` (`agent-core/agent-env.ts`) swaps in `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` and strips host Anthropic credentials; it throws if the key is missing (never silently bills the host account), and the container runner skips host-OAuth injection for provider-key jobs (`resolveContainerCredentialEnv`). Provider routing is `agentModelProvider(model)`. `AiRun.model` labels: `claude-agent-sdk:<id>[+effort]` vs `openrouter:<slug>` vs `litellm:<name>` vs `local:<name>`. Storable-value validation is shared client/server via `isStorableAgentModel`. Users also carry a personal default (`User.defaultAgentModel/-Effort`, set on `/slack/connected` after Slack linking, API `GET/PATCH /api/user/agent-defaults`); ALL agent runs (Slack, doc conversation, selection edit, comment reply) resolve doc config → triggering user default → app default (`resolveAgentConfigForUser` in `lib/agent-defaults.ts`, guarded by `tests/doc-user-default-model.test.ts`), and the doc page seeds the agent panel with the same effective config for the viewer. A fourth provider `local/<name>` targets the deployment's own llama.cpp server (Anthropic-compatible `/v1/messages`, tool use verified on qwen3.6-27b): no credential at all, just `LOCAL_MODEL_BASE_URL` + `LOCAL_MODEL_NAME` in `.env` (currently `http://host.docker.internal:8080` because llama-server binds 127.0.0.1 on this host; if it moves to another tailnet machine, start it with `--host 0.0.0.0` and put that machine's tailnet IP here). It is also the **automatic free fallback**: an Anthropic-model run with no credential anywhere runs on the local model instead of failing (`loadAgentEnvWithFreeFallback` in `lib/user-credentials.ts`, used by all three agent routes; the run timeline records the substitution).
- **GitHub auth is per-document, never global** (`resolveGithubAuthForDocument` in `lib/user-credentials.ts`): doc env `GITHUB_TOKEN` → triggering user's GitHub PAT (`UserCredential` provider "github") → owner's PAT → host token only for `AGENT_HOST_CREDENTIAL_ALLOWED_EMAILS` accounts. `ensureLinkedRepository` pins the resolved token as a repo-local `http.https://github.com/.extraheader` (worktrees share it, so background merges/pushes work without a user in scope); no token → anonymous git (public repos read-only). The host `GITHUB_TOKEN` is NOT allowlisted into agent containers — `loadAgentEnvForDocument` injects the doc-resolved token instead. Don't reintroduce a global token into `runCommand`; that was a confused-deputy hole (any user could act on every repo the bot account can see). SSH repo URLs are rejected at the repository route for the same reason.
- **Skill catalog** (`lib/skill-catalog.ts`): a curated public git repo of skill folders (default `longtermrisk/claude-skills`, override `SKILL_CATALOG_GIT_URL` — accepts local paths, which is how `tests/skill-catalog.test.ts` works). Shallow-cloned into `.skill-catalog/` (10 min TTL, atomic rename, stale-on-failure). `GET /api/skill-catalog` lists; `{ catalogName }` on `POST /api/user/skills` or `POST /api/documents/[id]/skills` installs with one click (UI: document Skills menu + AI-credentials skills section). Installs reuse `prepareSkillUpload`, so the same sanitization/limits apply. The agent system prompt also discloses run env var NAMES (doc env + injected creds + LiteLLM/local host config; never values) via `agentEnvKeysForPrompt` in `agent-core/agent-env.ts` — an agent-core change, so image rebuilds apply.
- **Credential broker** (`lib/credential-broker/`): opt-in via `AGENT_CREDENTIAL_BROKER=1` in `.env` (off by default). When on, `loadAgentEnvWithFreeFallback` (given an `aiRunId`) replaces LLM credentials in the agent env with per-run virtual keys (`rdocs-vk-<hex>`, SHA-256-hashed `AgentBrokerKey` rows, real secret AES-encrypted or `secretRef: "host-claude-oauth"` resolved live per request) and points the matching `*_BASE_URL` at `/api/broker/<keyId>/…`, which swaps virtual→real and streams to the upstream. Every proxied request re-checks `AiRun.status === "RUNNING"`; `markAiRunSucceeded` and the abandoned-run reaper revoke keys and wipe secrets, plus a 12h TTL. Covered: ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN (+ host-OAuth fallback), OPENAI_API_KEY, OPENROUTER_API_KEY (via the `OPENROUTER_BASE_URL` override in `applyProviderEnv` — an agent-core change, so the image rebuild applies), LITELLM_API_KEY. `GITHUB_TOKEN` is deliberately NOT brokered (the real token is already pinned in the worktree git config). Requests arriving through Cloudflare (`cf-ray`) are rejected unless `BROKER_ALLOW_PUBLIC=1`. Secret-vs-config classification lives on `DocumentEnvVar.isSecret` (null = name heuristic in `lib/document-env.ts`); config vars render unmasked in the Env menu, secrets stay masked. Tests: `tests/credential-broker.test.ts`.
- **Rebuild the agent image after `agent-core/` changes**: `docker build -f runner/Dockerfile.agent -t gdocs-agent:local .` — `gdocs-ai.sh` does NOT do this, and a stale image runs old agent-core code inside the container (env-var-only changes don't need it). A stale image is the confusing failure mode for OpenRouter runs: old `resolveAgentSdkConfig` silently falls back to the default Anthropic model.

## Things that have caused real failures (so far)

- **Cloudflare 524 on long edits.** Server finished, client never got the response. Distinguishable by `status:524` + `elapsedMs ≥ ~100000` in `client-log:error scope:ai-edit`. The right fix is async edits with polling; until then, large reformats will fail.
- **Selection marker lost during long agent runs.** Any doc mutation while the agent is working can strip the `aiEditRange` mark. Diagnosed via `scope:ai-edit-marker-lost`'s `presence` payload.
- **Iframe self-feedback in widget views.** Plotly-style autosize widgets used to inflate to 6× viewport height. `EmbeddedWidgetView` in `nodes.tsx` now ignores `ResizeObserver` ticks that look like echoes of its own height changes.
- **Comments on atom block nodes** (widget / repoImage / image). Originally impossible because `commentAnchor` is an inline Mark. Now stored as `commentThreadIds` attribute on the block node.
- **Orphaned next-server serving a stale build.** Killing the `.service.pid` process leaves the `next-server` child alive; it survives SIGTERM, keeps serving the old build over cloudflared's established keep-alive connections even after losing its listener, and the next deploy's `npm run build` rewrites `.next` under it (old HTML → missing chunks → `ChunkLoadError: Loading chunk N failed`) before dying with EADDRINUSE. Diagnose with `ps aux | grep next-server` (more than one = bug) and per-process `lsof` on the log fds; fix is in `gdocs-ai.sh` (frees the port + kills established-connection holders) plus `ChunkReloadRecovery` client-side.
