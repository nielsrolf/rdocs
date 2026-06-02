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



## Isolated workspaces — DONE (practical confinement)
An agent should be sandboxed to its document's workspace, i.e. it should not be able to read files from outside of that. (Maybe this is already the case? Not sure)
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


## Using user provided claude tokens — DEFERRED (needs a design discussion)
Currently, all claude usage runs through my account. I want people to be able to use this without paying, so they need to bring their own tokens. Therefore, all AI features should only be available to logged-in users that have connected their claude:
- Deferred per discussion (2026-05-29). Ideal is reusing the `claude login` subscription OAuth flow (open URL, paste code back) so usage draws on the user's Claude Code subscription budget; "paste an API key" is an acceptable fallback. The Agent SDK exposes Claude OAuth control requests (SDKControlClaudeAuthenticate / SDKControlClaudeOAuthCallback / SDKControlClaudeOAuthWaitForCompletion) that may support this — to be scoped in a dedicated session.
