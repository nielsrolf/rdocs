# r-docs

Short for **research-docs** and **repo-docs**: a Google Docs-style workspace where a rich-text research document lives next to the repository it produces.

Features:

- rich text editing
- realtime collaboration, suggestions, presence, mentions, and version history
- threaded comments on text and block assets, with an `Ask AI` action
- user sign-up/sign-in
- direct collaborator sharing by email
- permissioned share links for `view`, `comment`, and `edit`
- document-level and selection-level agents with progress, cancellation, and continuations
- isolated repository worktrees, commits, widgets, images, attachments, and exports
- per-user AI/GitHub credentials plus per-document encrypted environment variables
- an MCP bridge for external agents

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
- `CREDENTIAL_ENCRYPTION_KEY` (generate with `openssl rand -base64 32`)
- an AI provider credential, or `LOCAL_MODEL_BASE_URL` + `LOCAL_MODEL_NAME` for the free local fallback

4. Initialize the database:

```bash
npx prisma generate
npx prisma db push
npm run db:migrate-security
```

5. Start the app:

```bash
npm run dev
```

## Security model

- Agent runs use the configured runner (`container` is the production target); repository work is isolated per run.
- Comment-link agents are read-only; edit-link agents receive workspace command and repository access. View links cannot start agents.
- Share tokens are runtime capabilities and are never persisted in document nodes or asset URLs.
- Agent-authored widgets run in an opaque-origin iframe sandbox.
- Personal credentials and per-document environment values are encrypted at rest.

## Checks

```bash
npm test
npx tsc --noEmit -p .
npm run lint
npm audit --omit=dev
```

## Key paths

- `app/documents/[id]/page.tsx`: document workspace page
- `components/document-workspace.tsx`: editor, comments, share links, Ask AI UI
- `app/api/comments/[threadId]/ask-ai/route.ts`: asynchronous comment-agent endpoint
- `agent-core/`: provider-neutral agent runtime, prompts, tools, and validation
- `lib/agent-runner/`: in-process/container/remote execution seam
- `lib/mcp/`: authenticated MCP bridge and collaboration-backed edits
