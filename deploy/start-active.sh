#!/usr/bin/env bash
# Bring the ACTIVE color back up from its existing build — no build, no
# upstream switch, about 10 seconds. For when the app process is gone but the
# load balancer still points at it (502s): the app was killed, crashed, or the
# systemd user manager was restarted (app instances live in its scopes; the LB
# lives in the system unit nr-r-docs and survives). Does nothing when the
# active color already answers. Not a deploy: to ship code use deploy.sh.
#
# Usage: ./deploy/start-active.sh
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

log() { echo "[start-active] $*"; }
fail() { echo "[start-active] ERROR: $*" >&2; exit 1; }

# Same docker-group rule as deploy.sh: the app must be able to reach the
# docker socket, and a caller started before the group membership cannot.
has_group() { tr ' ' '\n' | grep -qx docker; }
if ! id -Gn | has_group; then
  if [ -z "${RDOCS_DOCKER_GROUP_REEXEC:-}" ] && id -Gn "$(id -un)" | has_group && command -v sg >/dev/null 2>&1; then
    export RDOCS_DOCKER_GROUP_REEXEC=1
    exec sg docker -c "$(printf '%q ' "$ROOT/deploy/start-active.sh" "$@")"
  fi
  echo "[start-active] WARNING: no docker group access — agent container runs will fail" >&2
fi

# shellcheck disable=SC1091
. "$ROOT/deploy/port-listeners.sh"

# Never race a deploy: it may be starting or switching colors right now.
exec 9>.deploy.lock
flock -n 9 || fail "a deploy is running (.deploy.lock); let it finish"

COLOR="$(cat .deploy-active 2>/dev/null || true)"
case "$COLOR" in
  blue) PORT=14142 ;;
  green) PORT=14143 ;;
  *) fail "no active color recorded in .deploy-active — run ./deploy/deploy.sh instead" ;;
esac
HEALTH="http://localhost:$PORT/api/health"

if curl -sf -m 5 "$HEALTH" >/dev/null 2>&1; then
  log "$COLOR already answers on :$PORT — nothing to do"
  exit 0
fi
port_in_use "$PORT" && fail ":$PORT is held by something that does not answer /api/health: $(ss -tlnH "sport = :$PORT" | head -1)"
[ -f ".next-$COLOR/BUILD_ID" ] || fail "no build in .next-$COLOR — run ./deploy/deploy.sh instead"

set -a
# shellcheck disable=SC1091
. ./.env
set +a

if systemd-run --user --scope --quiet true >/dev/null 2>&1; then
  detached() { systemd-run --user --scope --quiet --collect --unit="rdocs-app-$COLOR-$(date +%s)" nohup "$@"; }
else
  detached() { nohup "$@"; }
fi

mkdir -p logs
APP_LOG="logs/service_${COLOR}_$(date +%Y%m%d_%H%M%S).log"
log "starting $COLOR on :$PORT from the existing build (log: $APP_LOG)"
PORT=$PORT NEXT_DIST_DIR=".next-$COLOR" detached npm run start 9>&- > "$APP_LOG" 2>&1 &
echo "$!" > ".service_${COLOR}.pid"

for _ in $(seq 1 60); do
  if curl -sf -m 3 "$HEALTH" >/dev/null 2>&1; then
    log "$COLOR is healthy: $(curl -s -m 3 "$HEALTH")"
    log "via LB: $(curl -s -m 5 http://localhost:14141/api/health)"
    exit 0
  fi
  sleep 1
done
fail "$COLOR did not become healthy within 60s — see $APP_LOG"
