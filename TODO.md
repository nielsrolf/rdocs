# TODO: 

# Bugs

[Potentially resolved, need to test] When two people collaborate in real-time on a document, the cursor of the other person often jumps around while typing. Can we prevent this? Some ideas regarding how:
- use the same update cycle (in broadcasting messages and while updating the frontend) for cursor position and changes in the text
- use some error correction thingy to update cursor position, like text directly before and after the cursor. Make it the priority that this is not violated, and use cursor offset only as secondary source of information and to resolve ambiguity
- something else?

# Security

## Document environments — DONE
Many projects need access to some secrets. E.g. research code may need LLM API calls or provision GPUs. Each document should have its own environment and that environment should be used for all agent contexts. Only contributors with edit access can access the environment tab of a document, and we only display env's as "abc*****123", never the full envs. The agent environment should not inherit the host environment.
Tests:
- run the service with a host environment of FOO=bar and ask in a document that claude prints the value of FOO (this should fail)
- add tests that check that different docs have their own env's
- add tests that check that only collaborators can overwrite or add new envs
- DONE: new `DocumentEnvVar` model (per-doc key/value, write-only over the API). `lib/agent-env.ts` builds the agent env from an allow-list of host vars the agent needs (PATH/HOME/locale/TLS/XDG + `ANTHROPIC_*`/`CLAUDE_*`/`GITHUB_TOKEN`/`PYTHON_BIN`) plus the document's own vars layered on top — everything else (e.g. host `FOO`) is dropped; passed to the SDK via the `env` query option in `lib/ai.ts`, threaded through all three agent routes. Edit-gated CRUD API at `/api/documents/:id/environment` (values masked as `abc*****123` on read, never returned in full). UI: an "Env" topbar dropdown shown only to editors (`components/document-workspace/environment-menu.tsx`).
  - VERIFIED with a live agent run: with host `FOO=bar-host-secret` set, the agent's `echo $FOO` returned empty while a doc-configured `MY_DOC_SECRET` was visible — so host env is not inherited and per-doc env is. Tests: `tests/agent-env.test.ts` (scrubbing/masking/validation), `e2e/document-env.spec.ts` (UI add/mask/delete, per-doc isolation, editor-only 403 gating).
  - Note: the merge-conflict resolver in `lib/research-workspace.ts` still runs with the host env (not yet scrubbed); only the three main agent routes inject the scrubbed/per-doc env.



## Isolated workspaces — REAL SANDBOX via containers (P0–P2 done; P3+ in progress)
An agent should be sandboxed to its document's workspace, i.e. it should not be able to read files from outside of that.

**The pattern-matching guard below is NOT a sandbox** — it inspects command strings and is trivially bypassed (`cat $(echo /etc)/passwd`, `python -c "open('~/.ssh/id_rsa')"`, `cd` + relative paths, symlinks, …). The real boundary is OS-level: run the agent loop inside a hardened container. Plan: `/Users/slacki/.claude/plans/rosy-sparking-sutherland.md`. Branch: `sandbox-runner`.

- **P0 (done, `ec5e0c0`)**: extracted the framework-free agent runtime into `agent-core/` (query loop, prompt builders, agent-env, agent-sandbox, agent-config, widget-build, validation, shared types). Old `lib/` paths are re-export shims. No behavior change.
- **P1 (done, `022dfd8`)**: `lib/agent-runner/` seam. The 3 routes call `getAgentRunner().run(...)`. Modes: `inprocess` (server process; no OS sandbox; dev fallback, warns), `container` (P2), `http` (P3, stub that fails loudly).
- **P2 (done, `57fc911` + follow-up)**: `runner/Dockerfile.agent` (node:22-bookworm + python/git/ripgrep + SDK + tsx + agent-core) and `runner/agent-entrypoint.ts` (job on stdin → NDJSON frames on stdout; runs submission validation + the untrusted widget build IN-SANDBOX). `ContainerRunner` spawns the image with the worktree bind-mounted at `/workspace`, secrets via a host-side `--env-file`, `--user` host uid, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--read-only` + tmpfs, pids/mem limits, bridge network for egress, and ONLY the workspace mounted.
  - **VERIFIED with a live run (mode=container, real LLM):** the agent authenticated and ran in the container, wrote `proof.txt` (visible host-side, host-owned via the bind mount), and `ls ~` / host home / `/Users` / the app repo / a host `$FOO` secret were ALL unreachable — the `ls ~` leak is dead at the kernel boundary. A deterministic shell run with the same hardening profile confirms the same.
  - **Agent auth:** the SDK authenticates via an env credential (`ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`); `lib/agent-runner/agent-credential.ts` falls back to the host `~/.claude` OAuth access token (only the short-lived token, never the refresh token — strictly less than the in-process path). This is the channel the per-user credential feature (below) will use.
  - **Env scrub fix:** `agent-env.ts` now denylists a parent Claude Code's IPC/session vars (`CLAUDECODE`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_SESSION_ID`, …) which otherwise make the nested agent CLI exit 1.
  - Tests: `tests/agent-container.test.ts` (hardening args + env scrub), `tests/agent-credential.test.ts`, `tests/agent-runner.test.ts`, `tests/agent-env.test.ts` (denylist).
  - macOS note: Docker Desktop only shares configured paths into its Linux VM; the real worktrees under `.research-workspaces` (in the repo dir) work, but ad-hoc `/tmp` bind mounts may not. Optimized for Linux/Podman (the future mini PC).
- **P4 (done, `6477a6b`)**: the Claude merge-conflict resolver no longer runs on the host. `agent-core/merge-resolver.ts` (framework-free, now env-scrubbed + path-guarded) runs via the agent runner; under container mode it resolves conflicts in the bind-mounted base checkout IN-SANDBOX. `AgentRunner.resolveMergeConflicts`; entrypoint dispatches a `merge_resolve` job kind. VERIFIED live (real conflict resolved in-container, both sides combined, zero markers). This was the last host-side untrusted-code path.
- **Live in production:** `AGENT_RUNNER_MODE=container` is set in `.env`; the running service spawns a hardened container per agent run (verified via a real ai-edit that spawned a `gdocs-agent` container and SUCCEEDED). Image: `gdocs-agent:local`. **Rebuild the image after any `agent-core/`/`runner/` change** (`docker build -f runner/Dockerfile.agent -t gdocs-agent:local .`) — the image bakes a copy of `agent-core`; a service restart alone runs stale agent code.

- **Topology decision (2026-06-03): deploy the whole system on the single Linux mini PC → no HTTP layer needed.** Colocated, the app spawns containers locally (bind-mount), so the cross-host reason for the runner service disappears. Keep the web tier from holding root-equivalent container control by using **rootless Podman**. So:
  - **P5 is now the real next step (runtime hardening on the mini PC):**
    - **Rootless Podman** engine — `AGENT_CONTAINER_RUNTIME=podman`.
    - **gVisor (`runsc`)** as the OCI runtime — `AGENT_CONTAINER_OCI_RUNTIME=runsc` (plumbed: `buildContainerRunArgs` emits `--runtime`). User-space kernel so the agent's syscalls don't reach the host kernel — the proper boundary for untrusted code; plain runc shares the host kernel. Linux-only; verify node/python/git/pip work under it and measure I/O overhead. It's an extra layer on top of cap-drop/read-only/non-root/only-workspace-mounted, not a replacement.
    - **Egress allowlist** via a filtering proxy (only Anthropic API / PyPI / npm / needed CDNs) so a compromised agent can't exfiltrate freely. (mTLS only relevant if P3/remote is ever built.)
  - **P3 (remote `runner/` HTTP service + `git bundle` transport): DEFERRED / only-if-tiers-split.** Build it only if app and agent execution are later put on separate machines, or if rootless-Podman-from-the-web-tier is judged too risky and the runtime should sit behind a localhost-only service.

### Historical: pattern-matching guard (kept as cheap defense-in-depth, NOT the boundary)
- It was NOT the case before (bypassPermissions + full Bash, reads unrestricted). Implemented the chosen "SDK Seatbelt + path guard" approach:
  - Deterministic PreToolUse guard (`lib/agent-sandbox.ts`): structured file tools (Read/Write/Edit/MultiEdit/Grep/Glob/LS) are confined to the document's worktree, and Bash may not reference absolute paths inside a protected root (the gdocs-ai server repo, under which other documents' `.research-workspaces` worktrees live). Roots are realpath-canonicalised so symlinked components (macOS /tmp→/private/tmp) don't reject legitimate in-workspace reads. Wired as a `PreToolUse` hook in `lib/ai.ts`.
  - Kernel Seatbelt sandbox enabled (`sandbox: { enabled, failIfUnavailable:false, autoAllowBashIfSandboxed }`).
  - VERIFIED with a live agent run: in-workspace read succeeds; reading the gdocs-ai repo / a sibling doc's worktree is blocked; the agent still functions.
  - Tests: `tests/agent-sandbox.test.ts` (guard logic).
  - NOTE: the SDK's Seatbelt *filesystem-read* restriction is driven by permission rules, which `permissionMode: "bypassPermissions"` skips — so the kernel layer does not restrict reads under our trust model. The PreToolUse guard is therefore the effective read boundary.
  - FIXED (2026-06-02): the Bash guard previously used a *denylist* (block paths inside the server repo / "protected roots") and so missed the host **home directory** — which is the repo's *parent* — letting the agent run `ls ~` and read `~/.ssh` etc. (the user-reported leak below). Inverted it to a *confinement allowlist* in `lib/agent-sandbox.ts`: a Bash absolute path is allowed only if it is inside the document workspace or inside a curated system/toolchain allowlist (`DEFAULT_SYSTEM_PATH_ALLOWLIST` — `/usr`, `/bin`, `/etc`, `/tmp`, `/private`, … but **not** `/Users`, `/home`, `/root`). `extractAbsolutePaths` now also catches a bare `~`, and `$HOME`/`${HOME}` are expanded before matching. Regression tests in `tests/agent-sandbox.test.ts` (`ls ~`, `cat ~/.ssh/id_rsa`, `$HOME`/`${HOME}` forms, arbitrary out-of-workspace path). System toolchain paths remain readable by design (the agent needs them); personal data outside the workspace no longer is.

---

User review note:
In this document: https://docs.nielsrolf.com/documents/cmprgs1gj00dxrkdhfvo8qa7n

I originally had this content:
```
This is a test of the environment:


What is the value of $foo ?
Answer:

What is the pwd?
Answer:

Can you run ls ~?
Answer:
```

Then I asked for an AI edit to fill in the info and got:
```
What is the value of $foo ?

Answer: foo=moin

What is the pwd?



Answer: /Users/slacki/agents/automator/services/gdocs-ai/.research-workspaces/cmprgs1gj00dxrkdhfvo8qa7n/worktrees/cmps58uwr000twy9hqk57klm3-local



Can you run ls ~?

Answer:

agents         Applications   backup         bin            bots
claude-agent   Desktop        dev.py         Documents      Downloads
focus-app      gpt-oss.logs   Library        LICENSE        llms.sh
logs           mcp.json       mcp.json.bak   mcpbla         md-notes
meditate       miniconda3     models         Movies         Music
openweights    Pictures       Public         rag            README.md
research-assistant  setup_bots.sh  skills   source         todo.md
turingtest

```

The fact that the agent was able to run ls ~ and access ~ of the host is an issue and not in line with the specification

RESOLVED (2026-06-02): root cause was the Bash guard's denylist model — see the "FIXED" note under "Isolated workspaces" above. The guard now confines Bash to the workspace + a system-path allowlist; the home directory (and any other out-of-workspace user path) is denied. Reproduced first with failing tests in `tests/agent-sandbox.test.ts`, then fixed in `lib/agent-sandbox.ts`.




# Agent pipeline & robustness fixes — SHIPPED (2026-07-04)

One batch, all live-verified (a real container agent run returned a sorted, valid GFM table with no meta commentary):
- **Tables round-trip** (`lib/content.ts`): doc→markdown now emits valid GFM (delimiter row, escaped pipes) in all three serializations (selection markdown, plain-text findText haystack, AI blocks — one shared `serializeTableToGfm` so they can't diverge). Previously the delimiter row was missing, so agents echoed delimiter-less pipes that markdown-it inserted as a paragraph of literal `|` characters — the "table edits fail sometimes" bug.
- **Widget inline round-trip**: widgets serialize as `![widget: <label>](widget://<widgetId>)` placeholders; `buildAiEditInsertContent` resolves placeholders inline (existing by id, new array widgets by label / `widget://new`), heals the legacy `[Interactive widget: …](…)` link form, and appends unreferenced array widgets as before. The `summary || selectedText` fallback for empty replacements is DEAD (`ai-edit` route) — it used to insert the agent's meta summary into the document body (observed in production). Empty replacement + assets now applies as widget/image-only content instead of dropping the widgets client-side. Validation rejects echoed widget-metadata prose and obvious chat-style openers.
- **Prompt contract** (`agent-core/agent.ts`): replacementText now has an explicit drop-in contract (final document prose, no meta commentary, must read seamlessly with surrounding text); selection context is sent as fenced `<text_before_selection>`/`<text_after_selection>` blocks; question-shaped instructions must be answered in document voice; suggestion replacementText carries the same contract; user-prompt fields are fenced against label-collision.
- **Run robustness**: expired host OAuth tokens are refused pre-dispatch (re-read from disk, actionable error) instead of injected; classified 401s re-resolve the credential and retry once (container layer); transient retry broadened (429/5xx/529/overloaded/spawn failures) with 2 backed-off retries; comment-create 409 ("Anchor not yet saved") now auto-retries client-side without reverting the editor; FAILED selection edits keep their marker and show a Retry/Dismiss card (`ai-edit-retry` scope).
- **Mobile pass**: proper viewport meta (`width=device-width` — the app previously rendered at ~980px on phones), ≥16px inputs/editor text (no iOS zoom-jank), wrapping topbar, 44px tap targets, safe-area-aware toasts, bottom-sheet comment composer on small screens.
- **Integration tests** seed users via Prisma + locally-minted JWT (`tests/integration/helpers.ts`) — the suite outgrew the 10/min sign-up rate limit.

Known follow-ups (deliberately deferred, roughly in priority order):
1. **Resume abandoned runs** instead of reaping to FAILED: persist the serializable `AgentJob` on the AiRun row; on startup/reaper re-dispatch, reusing the surviving worktree. Also shorten the 15-min blind window with a boot-epoch check.
2. **Workspace mutex timeout** (`lib/research-workspace.ts` `withWorkspaceLock`): a wedged setup currently deadlocks a document's queue forever.
3. **Worktree GC**: crash-orphaned `.research-workspaces/**/worktrees` are never swept; push-failed worktrees are removed (lossy).
4. **Merge resolver on OpenRouter docs** (see OpenRouter follow-ups below).
5. UI re-connect prompt when a stored user credential 401s.

# Features


## OpenRouter models — SHIPPED (2026-07-03), follow-ups
Users can select OpenRouter models (curated list + custom slug, `openrouter/<author>/<model>` stored on `Document.agentModel`) once the document env has `OPENROUTER_API_KEY`. Runs go through the existing Claude Agent SDK pointed at OpenRouter's Anthropic-compatible endpoint (`applyProviderEnv` in `agent-core/agent-env.ts`). Follow-ups:
- **Merge resolver stays on the Anthropic default**: `lib/research-workspace.ts` doesn't pass `agentConfig`/`agentEnv` to `resolveMergeConflicts`. To make merge resolution follow an OpenRouter document, pass `agentConfig: { model: document.agentModel }` + `agentEnv: await loadDocumentEnv(documentId)` at that call site — `merge-resolver.ts` already resolves provider + env correctly.
- **Extended thinking is force-disabled for OpenRouter models** (`resolveAgentSdkConfig`). If the compat endpoint proves to accept/ignore Anthropic thinking params for non-Claude models, this can be relaxed there.
- **Scaffold dimension**: config is provider-shaped (`AgentModelProvider`), so a future non-SDK scaffold (pi/opencode) can be added as a new provider + runner without reworking UI/schema.
- An *invalid* (vs missing) OpenRouter key fails slowly — the SDK retries 401s 10× (~3 min) before the run fails.

## Per-user agent credentials — SHIPPED (2026-07-04, phases 1–4)
Implemented per the plan below: encrypted `UserCredential` (AES-256-GCM, key in `.env` `CREDENTIAL_ENCRYPTION_KEY`), masked CRUD at `/api/user/credentials`, topbar "AI credential" menu (paste an Anthropic API key or a `claude setup-token` OAuth token, with the ToS disclaimer), and resolution precedence document env → document OWNER's credential → host `~/.claude` fallback with exactly one credential var injected (`lib/user-credentials.ts` `loadAgentEnvForDocument`, used by all three agent routes). Phase 4 flag `AGENT_REQUIRE_USER_CREDENTIAL` (default off) disables the host fallback and fails fast with "Connect an Anthropic credential in settings." Additionally (2026-07-05) `AGENT_HOST_CREDENTIAL_ALLOWED_EMAILS` (set in `.env`) restricts the host-subscription fallback to documents owned by the listed accounts — everyone else must connect their own credential (verified live with a non-allowlisted user). Tests: `tests/user-credentials.test.ts` (16), `tests/integration/user-credentials.integration.test.ts` (live CRUD, verified green). Remaining follow-up: prompt a re-connect in the UI when a stored credential 401s (today it surfaces as a failed run with the actionable message).

### Original plan (for reference)
## Per-user agent credentials — PLANNED (do after sandboxing)
Currently all Claude usage runs through the host's `~/.claude` OAuth session (one account). Goal: each user connects their own Claude credential **once**, and every document they own inherits it; the agent then runs under the owner's credential.

Desired UX (per user review, 2026-06-03):
- A user can connect EITHER their Claude **subscription OAuth token** (preferred — we're using Claude Code anyway) OR paste an **Anthropic API key**.
- Configured once per user; all documents **owned by that user** inherit it automatically (no per-document setup).
- A document's own env (`DocumentEnvVar`) can still override (e.g. a shared/team doc with its own key).

### ⚠️ ToS reality check on the subscription path (researched 2026-06-22)
The "connect your Claude subscription" path is **mechanically trivial but legally contested**, and the policy has whipsawed all year. Record before building:
- **Timeline:** Jan 2026 — subscription OAuth tokens blocked for third-party tools, reversed within days. Feb 2026 — Consumer ToS revised to formally restrict OAuth auth to Claude Code and Claude.ai only. Apr 4 2026 — outright ban enforced on third-party agents using subscription credentials. May/Jun 2026 — announced a separate monthly "Agent SDK credit" ($20 Pro / $100 Max 5× / $200 Max 20×, billed at API rates) that *would* have officially blessed third-party subscription auth. **Jun 15 2026 — that credit rollout was paused**; usage stays on subscription limits as before, no credit to claim, "reworking the plan."
- **Canonical SDK docs still say** (Agent SDK overview, current): *"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Please use the API key authentication methods described in this document instead."*
- **Net:** there is **no clean, self-serve, sanctioned mechanism** for a hosted multi-tenant app to authenticate end-users' subscriptions right now. The "unless previously approved" clause implies a **partner-approval route** (contact Anthropic), not an OAuth client we can just register. Using a user's subscription via our service today sits in the restricted zone — tolerable for our own small set of subscription-holding users at their own risk, **not** safe to market broadly. If we want this properly, email Anthropic for approval.
- **API-key auth is unambiguously allowed** (Console keys; the Console "Claude Code" role can mint Claude-Code-scoped keys). It should be the default we ship.

### How the subscription connect flow actually works (no OAuth dance needed)
- The simplest "connect" is **`claude setup-token`**: the user runs it locally, it walks them through OAuth and prints a **1-year** token (prefix `sk-ant-oat01-`); they paste it into our settings UI and we store it and inject it as `CLAUDE_CODE_OAUTH_TOKEN`. Requires a Pro/Max/Team/Enterprise plan; scoped to inference only (can't do Remote Control — fine for us).
- **This removes the refresh machinery from the earlier sketch.** A `setup-token` token lasts a year, so we do *not* need `refreshToken`/`expiresAt` plumbing for the paste path — just store the token and prompt re-connect when it 401s. (The full `claude login` OAuth control-request flow — `SDKControlClaudeAuthenticate` etc. — is the alternative if we want in-app "connect" without leaving the browser, but it's strictly more work; defer it.)
- **SDK credential precedence** (so we inject exactly one): `ANTHROPIC_API_KEY` (X-Api-Key) → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` → subscription `/login`. If a `UserCredential` is `api_key`, inject only `ANTHROPIC_API_KEY`; if `oauth`, inject only `CLAUDE_CODE_OAUTH_TOKEN` and make sure no stray `ANTHROPIC_API_KEY` is in the run env (the container env scrub in `container-args.ts` already guards the empty-string case — extend it to drop the unused var entirely).

### Implementation sketch (extends the now-built sandbox plumbing)
- The agent already authenticates purely from its env (`ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`) — see `lib/agent-runner/agent-credential.ts` and `agent-core/agent-env.ts`. The container/runner injects whatever the agent env contains. So this feature only needs to change the **source** of that credential from the host `~/.claude` fallback to a **per-user store**. Both auth methods resolve to env vars, so the connect-method choice is orthogonal to the resolution plumbing.
- New `UserCredential` model (encrypted at rest): `userId`, `kind` (`oauth` | `api_key`), the secret (+ optional `expiresAt` for display; `refreshToken` only if we later add the in-app OAuth flow). Never returned in full over the API (mask like `DocumentEnvVar`).
- Credential resolution order when building a run's agent env: document env (`DocumentEnvVar`) → **document owner's `UserCredential`** → host `~/.claude` fallback (single-tenant/dev). Layer it the same way `loadDocumentEnv` results are layered today.
- Connect flow: **paste an Anthropic API key** (ship first, unambiguously allowed) **or paste a `claude setup-token` subscription token** (gate behind a clear in-app disclaimer about ToS/usage; treat as the user authorizing their own account at their own risk until/unless Anthropic approves us).
- Gate AI features on the owner having a connected credential once we stop using the host account.

### Build phases
1. `UserCredential` schema + encryption-at-rest + masked read API + `POST/GET/DELETE /api/user/credentials` (mirror `DocumentEnvVar` route patterns).
2. Settings UI: paste API key OR paste subscription token; show masked value + which kind is connected.
3. Resolution layer: extend the agent-env build in the three routes (`ai-edit`, `agents`, comment-reply) to layer owner `UserCredential` between doc env and host fallback; inject exactly one credential var per the precedence rule above.
4. Disable the host `~/.claude` fallback in multi-tenant mode (env flag); gate AI features when the owner has no credential.
5. Tests: resolution precedence (doc env > owner cred > host), single-var injection (oauth vs api_key, no stray `ANTHROPIC_API_KEY`), masked-read, 401→re-connect prompt.
- (Earlier context: deferred per discussion 2026-05-29. ToS research 2026-06-22.)
