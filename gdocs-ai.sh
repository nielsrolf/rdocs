#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

: "${DATABASE_URL:?DATABASE_URL must be set (via .env or environment)}"
: "${SESSION_SECRET:?SESSION_SECRET must be set (via .env or environment)}"

export PORT=14141

# Free the port before building. Killing the previous run's npm/script PID
# does not kill its next-server child, and a surviving child both keeps
# serving the OLD build through Cloudflare's keep-alive connections and makes
# our own `npm run start` die with EADDRINUSE after the build has already
# rewritten .next under it (stale HTML → missing chunks → ChunkLoadError).
for _ in $(seq 1 15); do
  LISTENERS=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
  if [ -z "$LISTENERS" ]; then
    break
  fi
  echo "[gdocs-ai.sh] killing previous listener(s) on :$PORT: $LISTENERS"
  # shellcheck disable=SC2086
  kill $LISTENERS 2>/dev/null || true
  sleep 1
  # Escalate if a listener survives politeness.
  LISTENERS=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$LISTENERS" ]; then
    # shellcheck disable=SC2086
    kill -9 $LISTENERS 2>/dev/null || true
    sleep 1
  fi
done
if [ -n "$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)" ]; then
  echo "[gdocs-ai.sh] port $PORT still occupied; refusing to build over a running server" >&2
  exit 1
fi

# A previous server can survive SIGTERM with its listener gone but its
# ESTABLISHED keep-alive connections (e.g. from cloudflared) still serving the
# old build. Kill anything still holding the SERVER side of a :$PORT socket —
# the "…:$PORT->client" direction — which never matches the tunnel's client
# side, so cloudflared is untouched.
STALE_SERVERS=$(lsof -nP -iTCP:"$PORT" -sTCP:ESTABLISHED 2>/dev/null | awk -v pat=":$PORT->" 'NR>1 && index($9, pat) > 0 {print $2}' | sort -u || true)
if [ -n "$STALE_SERVERS" ]; then
  echo "[gdocs-ai.sh] killing stale server(s) still holding :$PORT connections: $STALE_SERVERS"
  # shellcheck disable=SC2086
  kill -9 $STALE_SERVERS 2>/dev/null || true
  sleep 1
fi

npm ci
npx prisma generate
npx prisma db push --skip-generate
npm run db:migrate-security
npm run build

exec npm run start
