# GDocs AI

A Google Docs-style MVP with:

- rich text editing
- threaded comments on selected text
- an `Ask AI` button on each comment thread
- user sign-up/sign-in
- direct collaborator sharing by email
- permissioned share links for `view`, `comment`, and `edit`

The app is built as a Next.js frontend/server app with Prisma + SQLite for persistence. The Claude reply path uses a small Python helper with `localrouter`, which keeps the AI integration provider-agnostic and ready for later multi-model work.

## Stack

- Next.js App Router
- TypeScript
- Prisma + SQLite
- TipTap editor
- Custom cookie auth with signed JWT sessions
- Python `localrouter` helper for Claude comment replies

## Setup

1. Install Node dependencies:

```bash
npm install
```

2. Create the dedicated `uv` environment and sync Python dependencies:

```bash
uv venv
uv sync
```

3. Create your environment file:

```bash
cp .env.example .env
```

4. Set at least:

- `SESSION_SECRET`
- `ANTHROPIC_API_KEY`
- optionally `AI_COMMENT_MODEL` if your Anthropic/localrouter model id differs from the default

5. Initialize the database:

```bash
npx prisma generate
npx prisma db push
```

6. Start the app:

```bash
npm run dev
```

## Notes

- Anonymous users can open shared documents via a share link, but commenting/replying currently requires a signed-in user account.
- Comment anchors store both the selected text and current editor positions. That is enough for an MVP, but if the document changes heavily you will want a more resilient anchor strategy.
- The codebase is intentionally structured so you can add AI edit-on-selection next by reusing the same permission and document persistence paths.

## Key paths

- `app/documents/[id]/page.tsx`: document workspace page
- `components/document-workspace.tsx`: editor, comments, share links, Ask AI UI
- `app/api/comments/[threadId]/ask-ai/route.ts`: Claude reply endpoint
- `scripts/claude_comment_reply.py`: `localrouter` helper that talks to Claude
