# CLAUDE.md — working on r-docs (repo dir: r-docs)

A Next.js (App Router) + Prisma/SQLite + TipTap app that runs either the Claude Agent SDK or OpenAI Codex SDK for document edits, comment replies, and repo work. See `README.md` for the product description.

## Running the app

The service is deployed blue/green via `./deploy/deploy.sh` (see `deploy/README.md`): Caddy on `:14141` load-balances to app instances on `:14142`/`:14143`. `./manage.sh <start|stop|restart|status|logs>` wraps this for day-to-day operation, and `../manager.sh r-docs <command>` delegates to it — `restart` runs a zero-downtime deploy, never a kill-and-relaunch.

You are allowed to manage the service yourself when debugging — deploy whenever a server-side change needs to be live:

```bash
# Zero-downtime deploy of the current working tree (also bootstraps the
# whole stack if nothing is running). Build takes a few minutes; run it in
# the background (Bash run_in_background) and watch its output.
./deploy/deploy.sh   # or: ./manage.sh restart

# Verify:
./manage.sh status
curl -s localhost:14141/api/health
```

Never free port `14141` by killing its listener — that is the **load balancer**, not the app; killing it takes the site down while both app processes keep running unreachable behind it (this happened for real via the old manager.sh restart). Do not start the dev server (`npm run dev`); production `npm run start` is what the deploy uses.

### How the blue/green deploy works

`./deploy/deploy.sh` is the blue/green deploy path — see `deploy/README.md`. Caddy on `:14141` proxies to app instances on `:14142`/`:14143`; each release builds into its own dist dir (`NEXT_DIST_DIR=.next-blue|green`), and after the upstream switch the old process **drains gracefully**: Slack socket + scheduler stop, in-flight agent runs finish where they started (shared DB + Slack Web API), then it exits. `GET /api/health` reports `{ok, draining, activeRuns, pid, distDir}` (503 while draining); `POST /api/admin/drain` (Bearer `DEPLOY_SECRET` from `.env`) starts a drain. The boot sweep in `instrumentation.ts` is **silence-based** (`sweepAbandonedAiRuns`) — never revert it to "fail every RUNNING run at boot", or a new process kills the draining sibling's runs. Migrations must be expand/contract (old code serves the new schema during overlap). `legacy-single-process.sh` stays as the legacy/emergency single-process path; never run both at once — stop the full stack first (`./manage.sh stop`) before falling back.

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
   - Runs the document-selected harness through `AgentRunner`: `runClaudeResearchAgent` for Claude Code or `runCodexResearchAgent` for Codex.
   - Claude finishes through the `submit_response` MCP tool; Codex returns the equivalent strict structured response. Both pass through `validateSubmission`.
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
- **The `AI agent` running edits writes inside `.research-workspaces/<documentId>/worktrees/...`**, never in the r-docs repo itself. Despite the historical directory/function names, managed runs use a self-contained no-local clone there (a real `.git/` directory), not `git worktree add`: the container mounts only that directory, so a gitfile pointing into the unmounted base clone would break every git command. Every run starts from the app-managed base workspace `HEAD` (including its snapshot of uncommitted changes), fetches the configured remote, then merges the freshly fetched explicit branch or `origin/HEAD`; therefore it sees both local/unpushed workspace state and the newest non-conflicting remote state. A true conflict is resolved only in the isolated run checkout with the local workspace version preferred. Claude and Codex receive the exact same prepared host path mounted at `/workspace`; harness selection happens afterward and must never change workspace content. Completed commits are fetched back into the base object database before merge. Keep the one-workspace-mount isolation invariant. `runClaudeResearchAgentOnce` will throw if no isolated workspace is supplied. Regressions: `tests/workspace-link.test.ts`, `tests/agent-container.test.ts`.
- **Schema changes** must be mirrored on both the client TipTap schema (`components/document-workspace/nodes.tsx` + `document-workspace.tsx`) and the server schema (`lib/document-editor-schema.ts` + `lib/document-schema-nodes.ts`). The server schema is used to parse and re-render document content out-of-browser.
- **Tests**: `npm test` runs the headless suite (`tsx --test tests/*.test.ts`); `npm run test:integration` runs the HTTP suite against a running server (`GDOCS_TEST_URL`, default `http://localhost:14141`, skips if unreachable); `npm run test:e2e` runs Playwright. Lint with `npx tsc --noEmit -p .` and `npx next lint`.
- **Models & providers** (`agent-core/agent-config.ts`): `Document.agentModel` stores a canonical Anthropic id (`claude-sonnet-5` default, `claude-fable-5`, `claude-opus-5`; legacy rows may still hold the aliases `sonnet`/`opus` or the superseded `claude-opus-4-8`, all normalized on read), an OpenRouter model as `openrouter/<author>/<model>` (curated list + custom slug in the UI, gated on the document env having `OPENROUTER_API_KEY`), or a LiteLLM model as `litellm/<model-name>` (gated on `LITELLM_API_KEY`; also needs `LITELLM_BASE_URL` — per-doc, or the server-wide default in `.env`, which on this deployment is `http://host.docker.internal:9274`, the host's ssh tunnel to litellm.nielsrolf.com). Both third-party providers use the same Claude Agent SDK pointed at an Anthropic-compatible endpoint: `applyProviderEnv` (`agent-core/agent-env.ts`) swaps in `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` and strips host Anthropic credentials; it throws if the key is missing (never silently bills the host account), and the container runner skips host-OAuth injection for provider-key jobs (`resolveContainerCredentialEnv`). Provider routing is `agentModelProvider(model)`. `AiRun.model` labels: `claude-agent-sdk:<id>[+effort]` vs `openrouter:<slug>` vs `litellm:<name>` vs `local:<name>`. Storable-value validation is shared client/server via `isStorableAgentModel`. Additionally, ALL of the triggering user's (else the doc owner's) connected provider keys are injected into every run env as TOOL credentials — `OPENAI_API_KEY` / `OPENROUTER_API_KEY` / `LITELLM_API_KEY` — regardless of the selected model (`applyToolCredentialEnv` in `lib/user-credentials.ts`; doc env wins; Anthropic stays model-gated because `ANTHROPIC_*` is the SDK routing channel). With the broker on, these tool keys are brokered whenever present, not just for the matching model provider. Users also carry a personal default (`User.defaultAgentModel/-Effort`, set on `/slack/connected` after Slack linking, API `GET/PATCH /api/user/agent-defaults`); ALL agent runs (Slack, doc conversation, selection edit, comment reply) resolve doc config → triggering user default → app default (`resolveAgentConfigForUser` in `lib/agent-defaults.ts`, guarded by `tests/doc-user-default-model.test.ts`), and the doc page seeds the agent panel with the same effective config for the viewer. A fourth provider `local/<name>` targets the deployment's own llama.cpp server (Anthropic-compatible `/v1/messages`, tool use verified on qwen3.6-27b): no credential at all, just `LOCAL_MODEL_BASE_URL` + `LOCAL_MODEL_NAME` in `.env` (currently `http://host.docker.internal:8080` because llama-server binds 127.0.0.1 on this host; if it moves to another tailnet machine, start it with `--host 0.0.0.0` and put that machine's tailnet IP here). It is also the **automatic free fallback**: an Anthropic-model run with no credential anywhere runs on the local model instead of failing (`loadAgentEnvWithFreeFallback` in `lib/user-credentials.ts`, used by all three agent routes; the run timeline records the substitution).
- **No host credentials, ever.** Agent/model/GitHub credentials resolve only from document env or encrypted `UserCredential` rows (triggering user, then document owner). Host environment keys, `~/.claude`, and `~/.codex/auth.json` are never injected, copied, mounted, or used as fallbacks. Future ChatGPT-subscription support must store and refresh the login in the user's account and materialize it only inside that user's isolated run credential area. Enforcing this needs more than not *injecting* the credential: `HOME` is allowlisted, so `applyAgentConfigDirEnv` (`agent-core/agent-env.ts`) pins `CLAUDE_CONFIG_DIR` / `CODEX_HOME` to a run-scoped dir on EVERY path (in-process, container entrypoint, self-hosted worker, both merge resolvers) — otherwise the CLI finds the host's `~/.claude` session and *retries a rejected request with it*. With the broker on that surfaces as a run-killing `401 Credential broker: Missing or malformed broker token.`; without it, the host account silently pays. Runners pass the per-conversation session dir (which is also where transcripts land, so in-process runs get real resume); with none, agent-core falls back to a temp dir, never `$HOME`. Test: `tests/agent-config-dir.test.ts` drives the real CLI against a fake 401 endpoint with a planted host session.
- **GitHub auth is per-document, never global** (`resolveGithubAuthForDocument` in `lib/user-credentials.ts`): doc env `GITHUB_TOKEN` → triggering user's GitHub PAT (`UserCredential` provider "github") → owner's PAT. `ensureLinkedRepository` pins the resolved token as a repo-local `http.https://github.com/.extraheader`; no token → anonymous git. The host `GITHUB_TOKEN` is never considered.
- **Shared Slack-channel workspaces** (`Document.workspaceDocumentId`, `lib/workspace-link.ts`): a document can share the base workspace of a `slack_channel` document instead of linking a repo (mutually exclusive with `repoUrl` — setting either clears the other). Resolution happens in ONE place, `resolveWorkspaceDocumentId` in `lib/research-workspace.ts` (exactly one level deep; a dangling id falls back to the doc's own workspace), so ai-edit, conversations, ask-ai, repo-files, widgets, and MCP all inherit it via `ensureLinkedRepository`. Worktrees for linked docs live under the CHANNEL doc's dir (`LinkedRepository.workspaceDocumentId`), and GitHub auth for the shared workspace resolves against the channel doc. Linking requires EDIT access on the target channel document (API `GET/PATCH /api/documents/[id]/workspace-link`, UI in the Repo menu). Tests: `tests/workspace-link.test.ts`.
- **Skill catalog** (`lib/skill-catalog.ts`): a curated public git repo of skill folders (default `longtermrisk/claude-skills`, override `SKILL_CATALOG_GIT_URL` — accepts local paths, which is how `tests/skill-catalog.test.ts` works). Shallow-cloned into `.skill-catalog/` (10 min TTL, atomic rename, stale-on-failure). `GET /api/skill-catalog` lists; `{ catalogName }` on `POST /api/user/skills` or `POST /api/documents/[id]/skills` installs with one click (UI: document Skills menu + AI-credentials skills section). Installs reuse `prepareSkillUpload`, so the same sanitization/limits apply. The agent system prompt also discloses run env var NAMES (doc env + injected creds + LiteLLM/local host config; never values) via `agentEnvKeysForPrompt` in `agent-core/agent-env.ts` — an agent-core change, so image rebuilds apply.
- **Conversation session resume** (`lib/agent-sessions.ts`): follow-up conversation runs resume the selected harness's native session. Claude owns `$CLAUDE_CONFIG_DIR/projects/**/<sessionId>.jsonl`; Codex owns `$CODEX_HOME/sessions/**/rollout-…<threadId>.jsonl`. Each conversation gets a mounted native config root. The DB stores only the opaque SDK thread/session id in `AiRun.sdkSessionId`; it never serializes a Codex rollout into app schema or reconstructs one from `AiRunEvent`. Auth is separate from rollout persistence and never comes from the host. A recorded session whose transcript is gone (GC'd/deleted) still degrades to the clipped `buildConversationHistory` replay, but NEVER silently: `planSessionResume` returns `resumeUnavailableSessionId` and the conversation run records a visible timeline event saying earlier tool calls are not in context.
- **Context compaction** (`DEFAULT_AUTO_COMPACT_WINDOW` in `agent-core/agent-env.ts`): Claude Code's auto-compaction is on by default, but its default window is the model's FULL window (200k), so compaction only triggers at ~167k and one fat tool result can blow past the hard limit first → `Prompt is too long`, and a session that ends over the limit can never be resumed. `buildAgentEnv` therefore injects `CLAUDE_CODE_AUTO_COMPACT_WINDOW=150000` (host `.env` or document env override it). The CLI **clamps this to the model window**, so a value ≥ the window is a silent no-op — which is why the window and the `context-1m-2025-08-07` beta are decided together in `applyLongContextEnv`, called from `agent-core/agent.ts` right after `applyProviderEnv`: when the beta will really take effect it passes `Options.betas` and raises the window to `LONG_CONTEXT_AUTO_COMPACT_WINDOW=500000`; otherwise it passes no betas and leaves 150k. `usesLongContext` gates that on **provider `anthropic` + API-key auth**, and both halves are mandatory: third-party Anthropic-compatible endpoints (OpenRouter/LiteLLM/local) do not widen a window for this beta, and the CLI *discards* caller-supplied betas under subscription/OAuth auth ("Custom betas are only available for API key users") — declaring 500k in either case clamps back to 200k and switches compaction off entirely, i.e. reintroduces the original bug. A non-entitled API key is safe on its own: the CLI catches the 1M-credits rejection and clamps itself back to 200k. An explicit `.env`/document window always wins over both defaults. Floor 100k, ceiling 1M. Note the container env file carries only the 150k baseline; the upgrade happens in-container, where the run's credential shape is known. Tests: `tests/agent-env.test.ts`.
- **Credential broker** (`lib/credential-broker/`): with `AGENT_CREDENTIAL_BROKER=1`, resolved account/document LLM credentials become per-run virtual keys and the broker swaps virtual→real only while the run remains active. It never resolves host credentials. Request bodies are buffered once at this trust boundary so OpenAI-compatible Responses endpoints receive a concrete `Content-Length`. Covered: Anthropic API/OAuth, OpenAI, OpenRouter, and LiteLLM credentials.
- **Agent-panel run list** (`lib/ai-runs.ts`): the document poll returns up to `AI_RUN_LIST_LIMIT` (200) runs, but only the newest `AI_RUN_EVENT_RUNS` (12) carry event timelines inline; older runs come back with `eventsOmitted: true` and the client lazy-loads their events from `GET /api/documents/[id]/ai-runs/[runId]` (which now includes `events`) when the conversation is opened (`archivedRunEvents` state in `document-workspace.tsx`). Don't put events back on all rows — that bloats the 2s poll. Test: `tests/ai-run-list-window.test.ts`.
- **Agent timeline + result rendering** (`components/document-workspace/agent-timeline.tsx`, `agent-panel.tsx`, `run-result.ts`): tool events arrive as `"<ToolName>: <json>"` strings; the client parses them and renders custom rows (Bash terminal, Edit/MultiEdit/Write diffs, TodoWrite checklist, `mcp__server__tool` prettified to `server: tool name`). The lifecycle system messages emitted by `agent-core/agent.ts` ("Starting Claude research agent." / "Submitting final response." / "Preparing document update.") are matched VERBATIM by `lifecycleStepLabel` to render as quiet step rows, and the final-reply badge keys off the submit step — rewording those strings in agent-core requires updating the client matcher (and vice versa). Structured application outputs are not reconstructed from this lossy event stream: run detail returns the persisted final edit, comments (including the actual triggering-thread reply), and suggestions; `RunResultBlock` renders them for every turn and suppresses a final-reply duplicate when a newer event already contains the exact body. `toolInputSummary` deliberately ships clipped `old_string`/`new_string`/`content` so diffs can render; keep per-field clips small enough that the JSON stays parseable under the 1400-char event cap (unparseable JSON degrades gracefully to a raw-text row). The RESULT side is the richer source and works for historical runs: `parseToolResultData` interprets tool_use_result payloads (Read → line-numbered file view, Edit → diff from `oldString`/`newString`, Bash → `stdout`/`stderr` terminal, Write → added-file view, Grep matches), and `extractJsonStringField` recovers string fields from payloads clipped mid-JSON by the event cap. Tests: `tests/agent-timeline.test.ts`, `tests/agent-run-result.test.ts`.
- **Session plan rail** (`components/document-workspace/todo-outline.ts`, `agent-todo-outline.tsx`): every `TodoWrite` snapshot of a conversation is folded into ONE ordered outline rendered as a right-hand column of `.agent-main` — status as of the newest snapshot, the current step highlighted, click scrolls the timeline to the anchor event (`data-agent-event-id` on tool blocks). Two todo shapes must keep working: Claude's `{content,status}` and the Codex SDK's plan items `{text,completed}` (`normalizeTodoItem`); a payload clipped by the 1400-char event cap is recovered by a positional regex scan, and `toolInputSummary` clips per todo so the JSON usually stays parseable. `TodoWrite` is in `CLAUDE_AGENT_TOOLS` (`agent-core/ai-tools.ts`) — without it Claude runs emit no plan at all. Test: `tests/agent-todo-outline.test.ts`.
- **Harness routing / Codex**: `codex/openai/<model>` uses native OpenAI Responses auth from a connected/document `OPENAI_API_KEY`; `codex/litellm/<model>` uses LiteLLM's OpenAI-compatible Responses endpoint (`LITELLM_API_KEY` + `LITELLM_BASE_URL`). When a native Codex selection has no OpenAI credential but LiteLLM is connected, `loadAgentEnvWithFreeFallback` transparently routes the equivalent `codex/litellm/openai/<model>` and records the substitution in the run timeline. The configurator chooses LiteLLM by default when it is the only available Codex provider. Direct `codex/anthropic/*` values are invalid. Future ChatGPT subscription auth is account-managed, never host-managed. For Slack-triggered runs, both harnesses expose the same run-scoped Slack capabilities through `/api/slack/agent-tools`: Claude uses the legacy in-process tool callbacks and Codex mounts that endpoint as the `gdocs` MCP server, alongside the document `rdocs` MCP server. The shared tool set includes posting to the current thread, listing/reading channels and threads, recent activity, scheduling, and file sending; membership checks remain server-side. Regressions: `tests/slack-agent-tools.test.ts`, `tests/slack-agent-tools-mcp.test.ts`, `tests/codex-agent.test.ts`.
- **Submission correction loop**: application validation failures are model feedback, not immediate user-facing failures. Claude receives them as `submit_response` tool errors and may resubmit; Codex receives a same-thread correction prompt. Both get up to `MAX_SUBMISSION_ATTEMPTS` total submissions. Codex JSON parse failures use the same loop. Never fall back to trailing plain text after a rejected Claude submission; surface the final actionable rejection only after the bounded attempts are exhausted.
- **Rebuild agent images after `agent-core/` changes**: `docker build -f runner/Dockerfile.agent -t gdocs-agent:local .` and `docker build -f runner/Dockerfile.codex-agent -t gdocs-codex-agent:local .` — deploy scripts do NOT do this. Override the Codex image with `CODEX_AGENT_CONTAINER_IMAGE`.
- **Container UID on Docker Desktop**: macOS bind mounts appear as `root:root` inside Docker Desktop's Linux VM, so passing the macOS numeric UID makes `/workspace` and the mounted SDK session directory unwritable (`Codex app-server ... Permission denied`). `resolveContainerUser` deliberately omits `--user` on Darwin; the container remains restricted by dropped capabilities, `no-new-privileges`, read-only rootfs, and scoped mounts, while Docker Desktop maps bind writes back to the macOS owner. Claude runs additionally receive `IS_SANDBOX=1`, Claude Code's supported marker for permitting `bypassPermissions` as root when an outer sandbox is the security boundary; without it Claude exits before starting. That marker must survive BOTH environment boundaries: Docker args in `container-args.ts` and the SDK subprocess allowlist in `agent-core/agent-env.ts`. Codex must not receive this Claude-specific marker. Native Linux keeps `--user <host uid>:<host gid>`. Regressions: `tests/agent-container.test.ts`, `tests/agent-env.test.ts`.

- **Settings screens** (`/settings/<section>`, topbar button "Settings"): `SettingsNav` (`components/settings-nav.tsx`) tabs across sections — `/settings/agent` (AI & credentials, `SlackConnectConfig`) and `/settings/forum` (default quicktake audience via `PATCH /api/user/quicktake-settings`); `/settings` redirects to the first section. The topbar also carries an always-visible Studio/Forum mode switch (`components/topbar-mode-switch.tsx`), and forum routes get their own favicon via the nested `app/forum/icon.svg` (Next segment-scoped icon convention). Sharing a document with a group requires only *membership* of that group (owner or member — `POST /api/documents/[id]/groups`), while group member management stays owner-only; that split is intentional (team manager curates the group, everyone on the team publishes to it).

## Things that have caused real failures (so far)

- **Cloudflare 524 on long edits (FIXED — historical).** Server finished, client never got the response (`status:524` + `elapsedMs ≥ ~100000`). Fixed by making AI edits async: `POST /ai-edit` creates the `AiRun`, fires `runAiEditInBackground`, and returns immediately; the client polls run status and fetches the result (`ai-edit-kickoff` / `ai-edit-fetch-result` scopes). The ~100s Cloudflare ceiling now only matters for any NEW synchronous endpoint that does slow work inline — don't add one.
- **Selection marker lost during long agent runs.** Any doc mutation while the agent is working can strip the `aiEditRange` mark. Diagnosed via `scope:ai-edit-marker-lost`'s `presence` payload.
- **Iframe self-feedback in widget views.** Plotly-style autosize widgets used to inflate to 6× viewport height. `EmbeddedWidgetView` in `nodes.tsx` now ignores `ResizeObserver` ticks that look like echoes of its own height changes.
- **Comments on atom block nodes** (widget / repoImage / image). Originally impossible because `commentAnchor` is an inline Mark. Now stored as `commentThreadIds` attribute on the block node.
- **Ghost agent containers + leaked test scheduled tasks (2026-07-28).** `tests/scheduler.test.ts` runs against the REAL DB; a recurring fixture task left enabled fired daily via the production scheduler (36 leaked "check the eval dashboard" crons → 24 real agent runs/containers at 09:00). Separately, `docker run --rm` agent containers outlive a dying server process (deploy, crash, docker restart) and keep burning tokens with nobody consuming the result. Fixes: scheduler tests must disable the tasks they create; the reaper now `docker rm -f`s reaped runs' containers, and `reconcileRunContainers` (`lib/agent-runner/container-cleanup.ts`) sweeps containers of terminal/unknown runs on boot + every reaper pass, sparing RUNNING/PENDING (a draining blue/green sibling's runs). Tests: `tests/container-cleanup.test.ts`. Rule: any test that writes rows a background loop polls (scheduler, reaper) must leave them disabled/terminal.
- **Tab key stole focus into the tab-title rename input (2026-07-28).** Any focusable element rendered inside the editor DOM (the tab-title `<input>` + copy button in `TabBreakView`) becomes a browser Tab-navigation target whenever ProseMirror doesn't consume a Tab/Shift-Tab press (unsinkable first list item, plain paragraph, pre-hydration keypress) — the caret "jumps to the tab heading" instead of indenting. Fixes: `tabIndex={-1}` on both controls, plus the low-priority `TabIndentGuard` extension (`editor-extras.ts`) that swallows unhandled Tab/Shift-Tab after ListItem/TaskItem/Table bindings run. Rule: any focusable control inside a node view needs `tabIndex={-1}`. Test: `e2e/tab-key-indent.spec.ts` (note: e2e keypresses right after page load race hydration — click, assert `toBeFocused`, settle ~300ms first).
- **Orphaned next-server serving a stale build.** Killing the `.service.pid` process leaves the `next-server` child alive; it survives SIGTERM, keeps serving the old build over cloudflared's established keep-alive connections even after losing its listener, and the next deploy's `npm run build` rewrites `.next` under it (old HTML → missing chunks → `ChunkLoadError: Loading chunk N failed`) before dying with EADDRINUSE. Diagnose with `ps aux | grep next-server` (more than one = bug) and per-process `lsof` on the log fds; fix is in `legacy-single-process.sh` (frees the port + kills established-connection holders) plus `ChunkReloadRecovery` client-side; the blue/green deploy avoids the problem entirely (each color has its own dist dir).
