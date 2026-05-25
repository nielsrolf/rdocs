# r-docs

Short for **research-docs** and **repo-docs**: a Google Docs-style workspace where a rich-text research document lives next to the repository it produces.

Features:

- rich text editing
- threaded comments on selected text
- an `Ask AI` button on each comment thread
- user sign-up/sign-in
- direct collaborator sharing by email
- permissioned share links for `view`, `comment`, and `edit`

The app is built as a Next.js frontend/server app with Prisma + SQLite for persistence. Claude agent work runs through the TypeScript `@anthropic-ai/claude-agent-sdk` package.

## Stack

- Next.js App Router
- TypeScript
- Prisma + SQLite
- TipTap editor
- Custom cookie auth with signed JWT sessions
- Claude Agent SDK for document edits, comment replies, and repository work

## Setup

1. Install Node dependencies:

```bash
npm install
```

2. Create your environment file:

```bash
cp .env.example .env
```

3. Set at least:

- `SESSION_SECRET`
- `ANTHROPIC_API_KEY`
- optionally `CLAUDE_AGENT_MODEL` if you want a model other than the SDK default alias

4. Initialize the database:

```bash
npx prisma generate
npx prisma db push
```

5. Start the app:

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
- `lib/ai.ts`: Claude Agent SDK runner and document-output parsing
