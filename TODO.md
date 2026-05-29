# TODO / deferred work

Tracked items intentionally deferred. Most recent context first.

## Database maintenance / retention
- **`dev.db` has grown very large (~3 GB).** Likely dominated by `AiRunEvent`,
  `DocumentVersion`, and `CollaborationStep` rows plus accumulated test data.
  - Add a retention sweep (cron / startup): prune `AiRunEvent` older than N days,
    cap `DocumentVersion` history per document, drop `CollaborationStep` rows well
    below the latest durable version (the in-memory room only needs a recent
    window; older steps are only for cold catch-up).
  - Run `VACUUM` after large deletes to reclaim space.
  - Consider a separate test database so `npm test` / `test:integration` don't
    accumulate rows in the dev DB.

## Security (Phase 3 — discuss before implementing)
- Session revocation (`sessionVersion` on User, checked in `getCurrentUser`).
- CSRF: Origin/Referer check on mutating routes; consider SameSite=Strict.
- Comment authz holes: any commenter can resolve/retag any thread and delete any
  AI comment (see code review). Gate behind owner/author/editor.
- Share tokens travel in URLs (history/logs/Referer) — exchange for a scoped
  cookie at `/share/[token]`.
- Agent child env scrubbing (deferred per product decision): `runWidgetBuild` and
  the SDK inherit full `process.env` incl. `GITHUB_TOKEN`. Keep bypass mode +
  slacki-ai auth, but scrub other secrets. Also reconsider `canComment` vs
  `canEdit` for triggering agent runs.

## Test coverage gaps (need a browser: Playwright or jsdom)
- In-editor AI-edit apply (`insertContentAt`) and decoration rendering.
- Remote cursor/selection decoration placement end-to-end.
- The SSE-healthy polling backoff (P4c) — currently logic-reviewed + build-verified
  only.

## Phase 5/6 status
DONE (all with tests): restore-from-version, modal a11y (Escape/focus/
aria-labelledby + error-toast aria-live), find & replace, mobile tab navigation,
Markdown export, beforeunload guard, comment editing, word count.

Decomposition DONE: `useCollaborationStream`, `usePresence` extracted from
`document-workspace.tsx` (each behind the Playwright net).

Decomposition DELIBERATELY STOPPED HERE (not forced further): `useComments` and
`useAiRuns` are deeply coupled to editor/selection/many setters — extracting them
is high-churn for low user value and risks the very stale-closure/effect bugs the
original review flagged. The two extracted hooks already isolated the most
complex, most-coupled-but-bounded concern (live transport). Revisit only if the
component needs further change; do it one hook at a time against the e2e net.

Still nice-to-have (not started):
- Version DIFF view (side-by-side).
- True focus TRAP in modals (currently Escape + initial focus only).
- @mentions + notification fan-out (persisted notifications for offline users) —
  a whole subsystem.
- Orphaned-thread surfacing + fuzzy re-anchoring using stored
  `anchorText`/`anchorContext`.
