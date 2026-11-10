#!/usr/bin/env bash
# Deploy-to-prod hook (host side, fired by the user systemd timer
# rdocs-release-watch.timer every 2 min): when origin/release moves ahead of
# the deployed checkout, fast-forward to it and run the blue/green deploy,
# then refresh the dev data copy. Nothing happens unless `release` exists and
# is strictly ahead; a non-fast-forward (local commits not on release) is
# logged and left alone — never force anything on the production checkout.
set -uo pipefail
# The user systemd manager's PATH lacks ~/.local/bin, where caddy/node/npm live
# on this host; without it deploy.sh dies with "caddy not found" (2026-11-09).
export PATH="$HOME/.local/bin:$PATH"
cd "$(dirname "$0")/.."
LOG=logs/release-watch.log
mkdir -p logs
log() { echo "$(date '+%F %T') [release-watch] $*" | tee -a "$LOG"; }

exec 9>.release-watch.lock
flock -n 9 || exit 0

git fetch -q origin release 2>>"$LOG" || exit 0          # no release branch yet: nothing to do
TARGET=$(git rev-parse -q --verify origin/release 2>/dev/null) || exit 0
HEAD_SHA=$(git rev-parse HEAD)
# Compare against what is DEPLOYED (.deploy-sha, written by deploy.sh), not
# HEAD: agents commit directly in this checkout and then push to release, so
# HEAD already equals release and a HEAD comparison skipped every such release
# (nothing shipped 2026-11-08..09). No .deploy-sha yet = unknown = deploy.
DEPLOYED_SHA=$(cat .deploy-sha 2>/dev/null || true)
[ "$TARGET" = "$DEPLOYED_SHA" ] && { rm -f .release-watch-failed .release-watch-note; exit 0; }

# A condition that persists across ticks is logged ONCE, not every 2 minutes.
note_once() {  # note_once <key> <message>
  [ "$(cat .release-watch-note 2>/dev/null)" = "$1" ] && return 0
  echo "$1" > .release-watch-note
  log "$2"
}

# A release that fails to deploy is retried once and then parked: the watcher
# used to rebuild the same broken sha every 2 minutes for as long as nobody
# looked (2026-11-10: three full builds in six minutes against a stale
# listener). A new push to release, or deleting .release-watch-failed, retries.
MAX_ATTEMPTS=2
FAILED_SHA=""; FAILS=0
read -r FAILED_SHA FAILS < .release-watch-failed 2>/dev/null || true
if [ "$FAILED_SHA" = "$TARGET" ] && [ "${FAILS:-0}" -ge "$MAX_ATTEMPTS" ]; then
  note_once "parked $TARGET" "release $TARGET failed to deploy $FAILS times; parked until release moves (or rm .release-watch-failed)"
  exit 0
fi
if [ "$HEAD_SHA" != "$TARGET" ]; then
  if ! git merge-base --is-ancestor "$HEAD_SHA" "$TARGET"; then
    # HEAD has commits that are not on release (or diverged): deploying would
    # ship unreleased work, and a reset would destroy it. Leave it alone.
    note_once "ahead $HEAD_SHA $TARGET" "HEAD ($HEAD_SHA) is not an ancestor of origin/release ($TARGET); NOT deploying until HEAD is pushed to release"
    exit 0
  fi
fi
# deploy.sh's single-flight lock is .deploy.lock (held for the whole deploy).
# NOT .deploy-active: that file permanently stores the active color, so testing
# for it skipped every release once one deploy had ever run (2026-11-07).
if ! flock -n .deploy.lock true; then
  log "a deploy is already running (holding .deploy.lock); retry next tick"; exit 0
fi

rm -f .release-watch-note
log "deploying origin/release $TARGET (from $HEAD_SHA)"
if [ "$HEAD_SHA" != "$TARGET" ] && ! git merge -q --ff-only "$TARGET" >>"$LOG" 2>&1; then
  log "ff merge failed (dirty tree?) — see $LOG"; exit 1
fi
if NODE_OPTIONS="--max-old-space-size=8192" ./deploy/deploy.sh >>"$LOG" 2>&1; then
  rm -f .release-watch-failed .release-watch-note
  log "deploy ok: $(curl -s localhost:14141/api/health)"
else
  [ "$FAILED_SHA" = "$TARGET" ] && FAILS=$((FAILS + 1)) || FAILS=1
  echo "$TARGET $FAILS" > .release-watch-failed
  log "DEPLOY FAILED (attempt $FAILS/$MAX_ATTEMPTS for $TARGET) — old color keeps serving; see $LOG"
  exit 1
fi
./deploy/refresh-dev-data.sh >>"$LOG" 2>&1 || log "dev data refresh failed (non-fatal)"
