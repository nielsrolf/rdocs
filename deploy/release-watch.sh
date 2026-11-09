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
[ "$TARGET" = "$DEPLOYED_SHA" ] && exit 0
if [ "$HEAD_SHA" != "$TARGET" ]; then
  if ! git merge-base --is-ancestor "$HEAD_SHA" "$TARGET"; then
    # HEAD has commits that are not on release (or diverged): deploying would
    # ship unreleased work, and a reset would destroy it. Leave it alone.
    log "HEAD ($HEAD_SHA) is not an ancestor of origin/release ($TARGET); skipping"
    exit 0
  fi
fi
# deploy.sh's single-flight lock is .deploy.lock (held for the whole deploy).
# NOT .deploy-active: that file permanently stores the active color, so testing
# for it skipped every release once one deploy had ever run (2026-11-07).
if ! flock -n .deploy.lock true; then
  log "a deploy is already running (holding .deploy.lock); retry next tick"; exit 0
fi

log "deploying origin/release $TARGET (from $HEAD_SHA)"
if [ "$HEAD_SHA" != "$TARGET" ] && ! git merge -q --ff-only "$TARGET" >>"$LOG" 2>&1; then
  log "ff merge failed (dirty tree?) — see $LOG"; exit 1
fi
if NODE_OPTIONS="--max-old-space-size=8192" ./deploy/deploy.sh >>"$LOG" 2>&1; then
  log "deploy ok: $(curl -s localhost:14141/api/health)"
else
  log "DEPLOY FAILED — old color keeps serving; see $LOG"
  exit 1
fi
./deploy/refresh-dev-data.sh >>"$LOG" 2>&1 || log "dev data refresh failed (non-fatal)"
