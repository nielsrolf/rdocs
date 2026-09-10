#!/usr/bin/env bash
# Start (or restart) the dev instance INSIDE the durable app container.
#
# Expects: /workspace = this repo (the #rdocs-dev channel workspace), the host
# has written dev-data/rdocs.db + dev-data/.env (deploy/refresh-dev-data.sh),
# and GDOCS_APP_PORT is the container's published port (set by the runner).
#
#   dev/run-dev.sh            build if needed, (re)start on $GDOCS_APP_PORT
#   dev/run-dev.sh --rebuild  force a fresh `next build`
#   dev/run-dev.sh --stop
#
# Idempotent: a running instance is stopped first; logs in dev-data/dev.log.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${GDOCS_APP_PORT:-3000}"
PIDFILE=dev-data/dev.pid
LOG=dev-data/dev.log
DIST=.next-dev

log() { echo "[run-dev] $*"; }
stop() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    log "stopping pid $(cat "$PIDFILE")"; kill "$(cat "$PIDFILE")" || true
    for _ in $(seq 1 30); do kill -0 "$(cat "$PIDFILE")" 2>/dev/null || break; sleep 1; done
  fi
  rm -f "$PIDFILE"
  # anything else holding the port (e.g. a next-server that outlived its parent)
  fuser -k -TERM "$PORT/tcp" 2>/dev/null || true
}

[ -f dev-data/.env ] || { log "dev-data/.env missing — run deploy/refresh-dev-data.sh on the host"; exit 1; }
[ -f dev-data/rdocs.db ] || { log "dev-data/rdocs.db missing — run deploy/refresh-dev-data.sh on the host"; exit 1; }
set -a; . ./dev-data/.env; set +a
export NEXT_DIST_DIR="$DIST" PORT

case "${1:-}" in
  --stop) stop; exit 0 ;;
  --rebuild) rm -rf "$DIST" ;;
esac

[ -d node_modules ] || { log "npm ci"; npm ci --no-audit --no-fund; }
npx prisma generate >/dev/null
log "prisma db push (dev copy)"; npx prisma db push --skip-generate --accept-data-loss >/dev/null
if [ ! -f "$DIST/BUILD_ID" ]; then
  log "next build -> $DIST"; NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=6144}" npm run build
fi

stop
log "starting on :$PORT"
nohup npm run start -- -p "$PORT" >> "$LOG" 2>&1 &
echo $! > "$PIDFILE"
for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && { log "up: $(curl -s "http://127.0.0.1:$PORT/api/health")"; exit 0; }
  sleep 1
done
log "did not answer within 60s — see $LOG"; tail -20 "$LOG"; exit 1
