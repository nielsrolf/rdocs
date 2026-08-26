#!/usr/bin/env bash
# Post-install verification for docker-in-agent-container via Sysbox.
#
# Run AFTER installing sysbox-ce on the host and rebuilding the agent images:
#   docker build -f runner/Dockerfile.agent -t gdocs-agent:local .
#   bash runner/verify-sysbox-docker.sh
#
# Checks, in order:
#   1. sysbox-runc is registered with the Docker engine
#   2. bind-mount ownership round-trip: a file written by container root under
#      sysbox lands on the host owned by the CURRENT USER (sysbox idmapped
#      mounts). This is what lets the app commit agent output afterwards —
#      if this fails, the sysbox default must not ship.
#   3. an inner dockerd starts inside gdocs-agent:local and can run a container
#   4. the inner daemon sees ZERO host containers (isolation)
set -euo pipefail

IMAGE="${AGENT_CONTAINER_IMAGE:-gdocs-agent:local}"
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

# 1. runtime registered
docker info --format '{{json .Runtimes}}' | grep -q '"sysbox-runc"' \
  || fail "sysbox-runc is not registered with the Docker engine (is sysbox-ce installed and docker restarted?)"
ok "sysbox-runc runtime registered"

# 2. bind-mount ownership round-trip
TMPDIR_HOST="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_HOST"' EXIT
docker run --rm --runtime=sysbox-runc --entrypoint /bin/sh -v "$TMPDIR_HOST":/mnt "$IMAGE" \
  -c 'echo hi > /mnt/probe.txt' \
  || fail "could not write into a bind mount under sysbox"
OWNER_UID="$(stat -c %u "$TMPDIR_HOST/probe.txt")"
if [ "$OWNER_UID" != "$(id -u)" ]; then
  fail "bind-mounted file written by container root is owned by uid $OWNER_UID on the host (expected $(id -u)). The app could not commit agent output — do NOT enable the sysbox default; check sysbox idmapped-mount/shiftfs support for this kernel."
fi
ok "bind-mount ownership round-trip (container root -> host uid $(id -u))"

# 3+4. inner dockerd + isolation, using the image's own docker install
docker run --rm --runtime=sysbox-runc --entrypoint /bin/sh "$IMAGE" -c '
  set -e
  dockerd > /var/log/dockerd.log 2>&1 &
  for i in $(seq 1 80); do [ -S /var/run/docker.sock ] && break; sleep 0.25; done
  [ -S /var/run/docker.sock ] || { echo "inner dockerd never came up"; tail -20 /var/log/dockerd.log; exit 1; }
  docker version --format "inner docker {{.Server.Version}}"
  COUNT=$(docker ps -aq | wc -l)
  [ "$COUNT" = "0" ] || { echo "inner daemon sees $COUNT containers (expected 0)"; exit 1; }
  docker run --rm hello-world > /dev/null
  echo "inner hello-world ran"
' || fail "inner dockerd / hello-world check failed"
ok "inner dockerd starts, is empty, and can run containers"

echo
echo "All checks passed. Restart the r-docs service to pick up sysbox detection:"
echo "  ./manage.sh restart"
