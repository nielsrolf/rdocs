# TODO: 


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
- **P3 (next)**: standalone `runner/` HTTP service (bearer auth, NDJSON streaming) + `git bundle` workspace transport for cross-host runs; app `HttpRunner` points at `RUNNER_URL` (the dedicated mini PC). Best built/verified once the Linux mini PC (or a Linux VM) exists. **P5**: egress allowlist (filtering proxy) + mTLS between app and runner.

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




# Features


## Per-user agent credentials — PLANNED (do after sandboxing)
Currently all Claude usage runs through the host's `~/.claude` OAuth session (one account). Goal: each user connects their own Claude credential **once**, and every document they own inherits it; the agent then runs under the owner's credential.

Desired UX (per user review, 2026-06-03):
- A user can connect EITHER their Claude **subscription OAuth token** (preferred — we're using Claude Code anyway) OR paste an **Anthropic API key**.
- Configured once per user; all documents **owned by that user** inherit it automatically (no per-document setup).
- A document's own env (`DocumentEnvVar`) can still override (e.g. a shared/team doc with its own key).

Implementation sketch (extends the now-built sandbox plumbing):
- The agent already authenticates purely from its env (`ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`) — see `lib/agent-runner/agent-credential.ts` and `agent-core/agent-env.ts`. The container/runner injects whatever the agent env contains. So this feature only needs to change the **source** of that credential from the host `~/.claude` fallback to a **per-user store**.
- New `UserCredential` model (encrypted at rest): `userId`, `kind` (`oauth` | `api_key`), the secret (+ OAuth `refreshToken`/`expiresAt` for refresh). Never returned in full over the API (mask like `DocumentEnvVar`).
- Credential resolution order when building a run's agent env: document env (`DocumentEnvVar`) → **document owner's `UserCredential`** → host `~/.claude` fallback (single-tenant/dev). Layer it the same way `loadDocumentEnv` results are layered today.
- Connect flow: reuse the `claude login` subscription OAuth flow (open URL, paste code back). The Agent SDK exposes Claude OAuth control requests (SDKControlClaudeAuthenticate / SDKControlClaudeOAuthCallback / SDKControlClaudeOAuthWaitForCompletion) — scope these for the paste-code-back loop. API-key paste is the simple fallback.
- OAuth token refresh: store `refreshToken`; refresh server-side before a run when `expiresAt` is near (the host `~/.claude` CLI does this today; we'd replicate the refresh call).
- Gate AI features on the owner having a connected credential once we stop using the host account.
- (Earlier context: deferred per discussion 2026-05-29.)
