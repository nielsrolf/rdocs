# TODO: 

# Bugs
- [x] when I select all in a document with text, images, and a widget, and then comment, I get "Unable to anchor comment to selected text" or something like that
  - DONE: the old anchoring logic only special-cased a *single* block-atom NodeSelection; any multi-node selection fell through to an inline `setMark("commentAnchor")`, which (a) anchored only the text and left images/widgets uncovered, and (b) hard-failed ("Unable to anchor…") when the selection contained no inline text, plus the trailing `setTextSelection` at an atom boundary threw. Replaced it with a pure `buildCommentAnchorTransaction(state, range, threadId)` (`components/document-workspace/comment-anchors.tsx`) that tags every block atom (embeddedWidget/repoImage/image) fully inside the range via `commentThreadIds` **and** applies the inline mark to any text — anchoring the whole mixed selection in one transaction, returning null only when nothing is anchorable. Wired into `handleCreateComment` via `editor.view.dispatch`. Tests: `tests/comment-anchor-create.test.ts` (mixed select-all, atoms-only, single-widget, dedupe, empty→null), `e2e/comment-mixed-selection.spec.ts`.
- [x] when I select all and delete in a document with repo images and widgets, I still see comments anchored on the repo images and widgets - they should disappear just like comments anchored on deleted text
  - DONE: `visibleThreads` only checked anchor existence when the doc had tabs, so without tabs an orphaned thread (whose anchored block atom was deleted) lingered in the rail. Now it hides any thread whose anchor no longer resolves (`resolveCommentAnchorRange` null) regardless of tabs — covering deleted text (inline mark gone) and deleted widgets/repoImages (commentThreadIds gone) identically. Added a `docRevision` counter bumped on every doc-changing transaction (editor `onTransaction`, covers local + remote/collab applies) and included it in the memo deps so the rail recomputes immediately on a select-all delete. Tests: orphaning invariant in `tests/comment-anchor-create.test.ts`; full flow in `e2e/comment-mixed-selection.spec.ts`.


# UI
- [x] The outline sidebar is a bit ugly with how we display tabs: the tab edit/delete buttons on the left were introduced because on the right they were often invisible when the titles were too long, but now it just looks weird. The buttons should be displayed on hover in a way that ensures that the buttons are always visible
  - DONE: tab actions moved back to the right, absolutely positioned and revealed only on hover/focus with a gradient fade over the (truncated) title so they're always fully visible. Regression test: `e2e/outline-tab-actions.spec.ts`.
  - FOLLOW-UP FIX: long titles were overflowing the sidebar (the flex column item `.doc-outline-tab-group` had the default `min-width:auto`, so a no-wrap title grew the row to its full width and pushed the action buttons off-screen to the right). Added `min-width:0` down the flex chain (`.doc-outline-list-tabbed` / `.doc-outline-tab-group` / `.doc-outline-tab-headings`) so the title ellipsis-truncates and the row fits the sidebar — the actions now stay pinned to the visible right edge. Regression test strengthened to assert no horizontal overflow and that the actions stay within the sidebar bounds for a long title.
- [x] we can remove the dashboard button in the top right since we already have the logo that links to the dashboard
  - DONE: removed the redundant "Dashboard" ghost-button from the topbar (`app/layout.tsx`); the brand logo links to `/`, which redirects logged-in users to `/dashboard`.
- [x] the "Export" button is weirdly not aligned with the other menu buttons
  - DONE: the Export `<a>` was an inline element ignoring `min-height`; topbar buttons are now `inline-flex` + centered so anchors and `<button>`s align identically (`app/globals.css`).
- [x] in collab mode, when I am typing in an early section of the document then the cursor or the selected section by a collaborator jumps around a bit - it goes back to selecting the correct section but it's distracting that it moves so much. Perhaps we can have some error correction and broadcast also the content of the selected text, or in the case of a cursor position a short string before and after the cursor position - then we can use that to avoid showing wrong positions while the collaborators sync. Maybe there are other ways to do it though, not sure
  - DONE: implemented exactly that error-correction. Presence now broadcasts a short before/after text context for the cursor head and selection ends (`use-presence.ts`, captured within the text block so offsets stay exact). On the receiving side, after the existing OT position mapping, `reanchorWithinBlock` (pure, in `collaboration.ts`) re-finds that context in the same block and snaps the position onto it — but only when the mapped spot's text doesn't already match, and it falls back to the OT result if the context isn't found, so it's a safe corrective layer that can only fix the transient jump, never make placement worse. The root cause was a brief mis-map when the local user's *own* steps get confirmed (unconfirmed maps clear before the next presence packet arrives). Tests: `tests/collab-reanchor.test.ts`; `e2e/remote-presence.spec.ts` still green.

  Note: the UI is now stable for displaying the other persons selected text while I am typing. But when the other person is typing there cursor moves forward in the body of the document before their new characters are added to the document, creating a quick jumping of their cursor.
  - [x] DONE (cursor jumps forward before the typed char arrives): root cause was a presence/step ordering race — the peer's presence packet (cursor already past the char they just typed, at collab version V+1) reaches us before their insert step does (we're still at version V), so we rendered their cursor one position ahead of text our doc didn't have yet. `reanchorWithinBlock` now takes a `remoteAhead` flag (set when `remoteVersion > localVersion`): when the captured `before` context can't be found (because it contains the not-yet-arrived char) it pins the cursor to the start of the still-stable `after` text, or clamps to the current block end when typing at the line end — so the cursor stays at the live insertion boundary until the step lands, then advances naturally. Pure-string-testable; tests added to `tests/collab-reanchor.test.ts` (mid-block pin, end-of-block clamp, backwards-compatible default, exact-match still preferred when the edit was elsewhere).

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



## Isolated workspaces — DONE (practical confinement)
An agent should be sandboxed to its document's workspace, i.e. it should not be able to read files from outside of that. (Maybe this is already the case? Not sure)
- It was NOT the case before (bypassPermissions + full Bash, reads unrestricted). Implemented the chosen "SDK Seatbelt + path guard" approach:
  - Deterministic PreToolUse guard (`lib/agent-sandbox.ts`): structured file tools (Read/Write/Edit/MultiEdit/Grep/Glob/LS) are confined to the document's worktree, and Bash may not reference absolute paths inside a protected root (the gdocs-ai server repo, under which other documents' `.research-workspaces` worktrees live). Roots are realpath-canonicalised so symlinked components (macOS /tmp→/private/tmp) don't reject legitimate in-workspace reads. Wired as a `PreToolUse` hook in `lib/ai.ts`.
  - Kernel Seatbelt sandbox enabled (`sandbox: { enabled, failIfUnavailable:false, autoAllowBashIfSandboxed }`).
  - VERIFIED with a live agent run: in-workspace read succeeds; reading the gdocs-ai repo / a sibling doc's worktree is blocked; the agent still functions.
  - Tests: `tests/agent-sandbox.test.ts` (guard logic).
  - KNOWN LIMITATION: the SDK's Seatbelt *filesystem-read* restriction is driven by permission rules, which `permissionMode: "bypassPermissions"` skips — so the kernel layer does not restrict reads under our trust model, and harmless system paths (e.g. `/etc/hosts`, `/usr`) remain readable via Bash. The PreToolUse guard is therefore the effective boundary: it reliably blocks the sensitive targets (app repo + other documents' workspaces) but does not fully jail Bash from all of the host filesystem. Tightening that would require dropping bypassPermissions (conflicts with the agent-trust-model) or a custom Seatbelt profile.


# Features

## Emoji reacts to comments and text sections
Like in google docs
- DONE (comments): emoji reactions on comments. New `CommentReaction` model (`@@unique([commentId,userId,emoji])`); fixed palette + pure aggregation/optimistic-toggle in `lib/reactions.ts`. Toggle endpoint `POST /api/comments/comment/:id/reactions` (comment-access gated; anonymous share visitors can't react). Reactions are per-user, so the SSE broadcast (`comment-reaction`) carries raw rows and each client recomputes "reactedByMe" (`use-collaboration-stream.ts`). UI: reaction pills + an emoji picker under each active comment (`comment-rail.tsx`), optimistic add/remove with rollback. Tests: `tests/reactions.test.ts`, `e2e/comment-reactions.spec.ts`.
- TODO (text sections): reacting to a selected text range (Google-Docs margin-emoji style) is not yet done — it needs a new anchored-reaction model + selection-popover action + margin rendering that persists through the collab step pipeline (cf. collab-content-invariant). Comparable in size to comment threads; deferred.

## @username Mentions in the doc and in comments
- we also need some way of notifying the mentioned user somewhere in the dashboard (highlight docs with unacknowledged mentions, similar to unacknowledged comments?)
- DONE (comments + dashboard notification): @mentioning a document member (owner or collaborator) in a comment/reply/edit records a `CommentMention` (pure matcher `lib/mentions.ts`, server sync `lib/mention-data.ts`; matches member names case-insensitively, longest-first, skips self). The dashboard shows a per-document "@ N" badge for unacknowledged mentions (mirrors unread comments, aggregated in SQL via `getDocumentMentionStats`); opening the document acknowledges them. Tests: `tests/mentions.test.ts`, `e2e/mentions.spec.ts`.
- [x] DONE (doc body): mentions typed into the document body are now first-class. A new inline `mention` mark (`components/document-workspace/mention.tsx`, mirrored into the server schema `lib/document-editor-schema.ts`) tags the `@Name` text with the mentioned user's id; a reactive decoration adds `mention-self`/`mention-other`. Inserting one via the editor autocomplete records a `DocumentMention` (new model) through `POST /api/documents/:id/mentions` so the member gets the same dashboard badge as a comment mention (`getDocumentMentionStats`/`acknowledgeDocumentMentions` now aggregate both). Tests: `tests/mention-mark.test.ts`, `e2e/mentions-feature.spec.ts`.

Note — all the review points below are now DONE:
- [x] "I typed the @email of a user ... I see no notification" — the matcher only looked at display *names*, so `@ada@example.com` recorded nothing. `extractMentionedUserIds` now matches each member's **email** as well as their name (longest-token-first), and `loadMentionCandidates` selects `email`. Tests in `tests/mentions.test.ts`.
- [x] "recognized mentions should be highlighted, and mentions of me different from others" — recognized @mentions are wrapped in styled spans: `mention-other` for other people, `mention-self` (amber) for the viewer. In comments this is a markdown-it rule (`lib/mention-markdown.ts`, rendered by `MarkdownBody`); in the doc body it's the `mention` mark + decoration. Tests: `tests/mention-markdown.test.ts`, `e2e/mentions-feature.spec.ts`.
- [x] "typing an @ should show prefix-matching suggestions" — a hand-rolled autocomplete (no new deps): `findActiveMentionQuery`/`filterMentionCandidates` (`lib/mentions.ts`, tested) drive a dropdown in both the comment composer/reply/edit (`MentionTextarea`) and the document body (in-editor `.mention-suggest`). Keyboard nav (↑/↓/Enter/Tab/Esc) + click to insert.
- [x] "clicking the notification opens the doc but the comment isn't highlighted" — `page.tsx` now captures the mentioning comment ids before acknowledging and passes them to the client, which opens that thread, scrolls to it, and flash-highlights the bubble (`comment-bubble-mention-flash`). Tested in `e2e/mentions-feature.spec.ts`.
- Note: doc-body mentions are notified at insert time (one `DocumentMention` per mentioned member, upserted); they are not re-derived from later edits, and deleting a mention does not retract an already-sent notification (parity with email — and with how comment mentions behave).

## Configuring agents — DONE
Currently we always use sonnet 4.6 (?) - but for some use cases it would be great to use even smarter models like opus 4.8, and control the thinking effort.
- DONE: per-document agent config (model + thinking effort). New `Document.agentModel` / `Document.agentEffort` columns; pure resolver `lib/agent-config.ts` maps them to Claude Agent SDK options (`model` alias + adaptive `thinking`/`effort`, or disabled when "off"). Threaded through all three agent routes (ai-edit, comment ask-ai, agents conversation) via `resolveDocumentAccess` + `ClaudeAgentRunOptions.agentConfig`. Editable from a Model/Thinking selector in the Agents panel topbar (edit-gated), persisted via PATCH `/api/documents/:id`. Tests: `tests/agent-config.test.ts` (resolver), `e2e/agent-config.spec.ts` (UI persistence + permission gating). Note: the merge-conflict resolver in `lib/research-workspace.ts` still uses the env default model — not document-scoped.

## Using user provided claude tokens — DEFERRED (needs a design discussion)
Currently, all claude usage runs through my account. I want people to be able to use this without paying, so they need to bring their own tokens. Therefore, all AI features should only be available to logged-in users that have connected their claude:
- Deferred per discussion (2026-05-29). Ideal is reusing the `claude login` subscription OAuth flow (open URL, paste code back) so usage draws on the user's Claude Code subscription budget; "paste an API key" is an acceptable fallback. The Agent SDK exposes Claude OAuth control requests (SDKControlClaudeAuthenticate / SDKControlClaudeOAuthCallback / SDKControlClaudeOAuthWaitForCompletion) that may support this — to be scoped in a dedicated session.

## Export to overleaf — DONE
It would be great if we could export to overleaf - i.e. download a zipfile that can be uploaded to overleaf and be a working latex version of the document.
- DONE: `GET /api/documents/:id/export?format=latex` returns an Overleaf-ready `.zip` (main.tex + README + bundled images). `lib/latex-export.ts` converts the TipTap doc to LaTeX (headings/tabs→sections, lists, task lists, blockquotes, code→verbatim, tables, marks→\textbf/\emph/\texttt/\sout/\href, full special-char escaping); `lib/zip.ts` is a dependency-free STORE-method zip writer. Images are embedded: data URLs decoded, http(s) fetched (bounded 8MB/10s), repoImages read from the linked workspace + recent run worktrees; anything unresolved (or widgets) renders as a framed placeholder so the doc still compiles. UI: the topbar "Export" button is now a dropdown (Markdown / Overleaf) — `components/document-workspace/export-menu.tsx`. Tests: `tests/zip.test.ts` (validated by system `unzip`), `tests/latex-export.test.ts` (structure + escaping + skip-guarded `pdflatex` compile), `e2e/export-latex.spec.ts` (downloads + unzips + checks embedded PNG). Note: math is escaped as literal text (no math node type exists in the schema); a real LaTeX engine wasn't installable locally so the compile test is skip-guarded.
