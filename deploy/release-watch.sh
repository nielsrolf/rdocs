#!/usr/bin/env bash
# Deploy-to-prod hook (host side, fired by the user systemd timer
# rdocs-release-watch.timer every 2 min): when origin/release moves ahead of
# the deployed checkout, fast-forward to it and run the blue/green deploy,
# then refresh the dev data copy. Nothing happens unless `release` exists and
# is strictly ahead; a non-fast-forward (local commits not on release) is
# logged and left alone — never force anything on the production checkout.
set -uo pipefail
cd "$(dirname "$0")/.."
LOG=logs/release-watch.log
mkdir -p logs
log() { echo "$(date '+%F %T') [release-watch] $*" | tee -a "$LOG"; }

exec 9>.release-watch.lock
flock -n 9 || exit 0

git fetch -q origin release 2>>"$LOG" || exit 0          # no release branch yet: nothing to do
TARGET=$(git rev-parse -q --verify origin/release 2>/dev/null) || exit 0
HEAD_SHA=$(git rev-parse HEAD)
[ "$TARGET" = "$HEAD_SHA" ] && exit 0
if ! git merge-base --is-ancestor "$HEAD_SHA" "$TARGET"; then
  log "origin/release ($TARGET) is not a fast-forward of HEAD ($HEAD_SHA); skipping"
  exit 0
fi
[ -f .deploy-active ] && { log "a deploy is already active; retry next tick"; exit 0; }

log "deploying origin/release $TARGET (from $HEAD_SHA)"
if ! git merge -q --ff-only "$TARGET" >>"$LOG" 2>&1; then
  log "ff merge failed (dirty tree?) — see $LOG"; exit 1
fi
if NODE_OPTIONS="--max-old-space-size=8192" ./deploy/deploy.sh >>"$LOG" 2>&1; then
  log "deploy ok: $(curl -s localhost:14141/api/health)"
else
  log "DEPLOY FAILED — old color keeps serving; see $LOG"
  exit 1
fi
./deploy/refresh-dev-data.sh >>"$LOG" 2>&1 || log "dev data refresh failed (non-fatal)"
