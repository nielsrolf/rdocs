# Zero-downtime deploys (blue/green + graceful drain)

```
cloudflared ──> Caddy :14141 (LB, admin API :2019)
                  ├── app "blue"  :14142  (builds into .next-blue)
                  └── app "green" :14143  (builds into .next-green)
```

## Deploying

```bash
./deploy/deploy.sh
```

What it does, in order:

1. Determines the inactive color (`.deploy-active`), frees only that color's port.
2. `npm install` **only if `package-lock.json` changed** (`npm ci` would delete
   `node_modules` under the live server — that's hidden downtime).
3. DB snapshot to `backups/`, then `prisma db push` + security migration.
   **Migrations must be expand/contract**: the old process serves old code
   against the new schema during the overlap, so only additive changes per
   deploy; destructive cleanup ships one deploy later.
4. Builds into the color's own dist dir (`NEXT_DIST_DIR=.next-<color>`) — the
   live server's artifacts are never rewritten (no more ChunkLoadError).
5. Starts the new server, waits for `GET /api/health` = 200.
6. Switches the Caddy upstream via the admin API (and rewrites
   `deploy/caddy.json` so a Caddy restart converges on the same color).
7. `POST /api/admin/drain` (Bearer `DEPLOY_SECRET` from `.env`) to the old
   process: it disconnects its Slack socket, stops claiming scheduled tasks,
   **finishes its in-flight agent runs** (shared SQLite + Slack Web API keep
   working without the listener), then exits on its own (max 2h, then it
   abandons leftovers to the silence reaper).

Total user-visible downtime: none. Running agents: uninterrupted — they finish
on the process that started them.

## First run (bootstrap)

If the legacy single-process server still owns `:14141`, `deploy.sh` kills it
(one final ~2–5s downtime, one final agent interruption) and starts Caddy on
`:14141` in its place. cloudflared config does not change. After bootstrap,
every subsequent deploy is zero-downtime.

`gdocs-ai.sh` remains as the legacy/emergency single-process path (it serves
`.next` on `:14141` directly); don't mix the two — if you fall back to it,
stop Caddy (`kill $(cat .lb.pid)`) and both color servers first.

## Why running agents survive

- Boot no longer fails every RUNNING/PENDING run. `instrumentation.ts` now
  uses the silence rule (`sweepAbandonedAiRuns`): a run whose heartbeat/events
  are fresh belongs to a live (possibly draining) sibling process and is left
  alone. Genuinely dead runs are failed + their workspaces salvaged, and a
  5-minute global reaper catches crashes even when nobody has the doc open.
- The scheduler's atomic `nextRunAt` claim already prevents double-fires
  while two processes overlap.
- Both processes hold Slack sockets during the overlap (Slack round-robins;
  both handle events correctly against the shared DB); drain closes the old
  one.

## Known small gaps during the overlap window

- **Cancel** only reaches runs owned by the process the LB routes to; a run
  on the draining process can't be cancelled from the UI (it just finishes).
- **Live collab/SSE** connections re-establish against the new process after
  the switch; pull-on-connect heals any missed steps.

## Operational bits

- Health: `curl localhost:14141/api/health` → `{ok, draining, activeRuns, pid, distDir, ...}` (503 while draining).
- Manual drain: `curl -X POST -H "Authorization: Bearer $DEPLOY_SECRET" localhost:<port>/api/admin/drain`.
- Caddy admin: `curl localhost:2019/config/` ; logs in `logs/caddy_*.log`;
  app logs in `logs/service_<color>_*.log`.
- State files (gitignored): `.deploy-active`, `.deploy-lockhash`,
  `.service_blue.pid` / `.service_green.pid`, `.lb.pid`, `deploy/caddy.json`.
