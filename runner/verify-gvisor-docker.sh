#!/usr/bin/env bash
# Post-install verification for docker-in-agent-container via gVisor (runsc).
#
# Run AFTER installing runsc on the host (`runsc install`, adding the runtimeArgs
# below to /etc/docker/daemon.json, restarting docker) and rebuilding the agent
# images:
#   docker build -f runner/Dockerfile.agent -t gdocs-agent:local .
#   bash runner/verify-gvisor-docker.sh
#
# Checks, in order (mirrors the flags buildContainerRunArgs emits for the
# gVisor profile — keep them in sync with lib/agent-runner/container-args.ts,
# and the dockerd recipe with maybeStartInnerDockerd in runner/agent-entrypoint.ts):
#   1. runsc is registered with the Docker engine, with --net-raw
#   2. the sandbox really is gVisor (dmesg prints "Starting gVisor")
#   3. privilege drop: the entrypoint's AGENT_RUN_USER path writes bind-mounted
#      files owned by the CURRENT USER — otherwise the app cannot commit output
#   4. an inner dockerd (--iptables=false + our SNAT rule) starts on the tmpfs
#      store, sees ZERO host containers (isolation), runs hello-world
#   5. inner containers have internet on the default bridge, on a user-defined
#      network (DNS via the embedded resolver, what compose uses), and with
#      --network=host; `docker build` works
set -euo pipefail

IMAGE="${AGENT_CONTAINER_IMAGE:-gdocs-agent:local}"
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

PROFILE=(--runtime runsc --cap-add ALL --read-only
  --tmpfs /tmp:rw,nosuid,nodev,exec
  --tmpfs /home/agent:rw,nosuid,nodev,exec
  --tmpfs /var/lib/docker:rw,exec,suid,dev,size=8g
  --tmpfs /var/lib/containerd:rw,exec,suid,dev,size=8g
  --tmpfs /run:rw,exec,suid,dev,size=256m
  --pids-limit 512 --memory 4g)

# 1. runtime registered
docker info --format '{{json .Runtimes}}' | grep -q '"runsc"' \
  || fail "runsc is not registered with the Docker engine (run 'sudo runsc install' and restart docker)"
ok "runsc runtime registered"
if [ -r /etc/docker/daemon.json ] && ! grep -q -- '--net-raw' /etc/docker/daemon.json; then
  fail "runsc is registered without --net-raw: inner containers would have no egress on bridge networks. In /etc/docker/daemon.json make the runsc entry
  \"runsc\": {\"path\": \"/usr/bin/runsc\", \"runtimeArgs\": [\"--net-raw\", \"--allow-packet-socket-write\"]}
then: sudo systemctl restart docker"
fi
ok "runsc has --net-raw"

# 2. really gVisor
docker run --rm --runtime runsc --entrypoint /bin/sh "$IMAGE" -c 'dmesg 2>/dev/null | head -1' | grep -qi gvisor \
  || fail "container under --runtime runsc does not report gVisor in dmesg"
ok "sandbox is gVisor"

# 3. bind-mount ownership after the privilege drop (uid/gid via setuid, as the entrypoint does)
TMPDIR_HOST="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_HOST" 2>/dev/null || true' EXIT
docker run --rm "${PROFILE[@]}" --entrypoint /bin/sh -v "$TMPDIR_HOST":/mnt "$IMAGE" \
  -c "setpriv --reuid=$(id -u) --regid=$(id -g) --clear-groups sh -c 'echo hi > /mnt/probe.txt'" \
  || fail "could not write into a bind mount as the dropped user under gVisor"
OWNER_UID="$(stat -c %u "$TMPDIR_HOST/probe.txt")"
[ "$OWNER_UID" = "$(id -u)" ] \
  || fail "bind-mounted file is owned by uid $OWNER_UID on the host (expected $(id -u)); the app could not commit agent output"
ok "bind-mount ownership round-trip (dropped user -> host uid $(id -u))"

# 4+5. inner dockerd on the tmpfs store, isolation, inner networking, build.
# Same recipe as gvisorDockerdArgs() in runner/agent-entrypoint.ts.
docker run --rm "${PROFILE[@]}" --entrypoint /bin/bash "$IMAGE" -c '
  set -e
  dev=$(awk "\$2==\"00000000\" && \$8==\"00000000\" {print \$1; exit}" /proc/net/route)
  addr=$(hostname -I | awk "{print \$1}")
  mtu=$(cat /sys/class/net/$dev/mtu)
  echo 1 > /proc/sys/net/ipv4/ip_forward
  for p in tcp udp; do
    iptables-legacy -t nat -A POSTROUTING -o "$dev" -p $p -j SNAT --to-source "$addr" \
      || { echo "SNAT rule failed: runsc is not running with --net-raw"; exit 1; }
  done
  dockerd --iptables=false --ip6tables=false --mtu="$mtu" > /tmp/dockerd.log 2>&1 &
  for i in $(seq 1 120); do [ -S /var/run/docker.sock ] && break; sleep 0.25; done
  [ -S /var/run/docker.sock ] || { echo "inner dockerd never came up"; tail -30 /tmp/dockerd.log; exit 1; }
  docker version --format "inner docker {{.Server.Version}}"
  COUNT=$(docker ps -aq | wc -l)
  [ "$COUNT" = "0" ] || { echo "inner daemon sees $COUNT containers (expected 0)"; exit 1; }
  docker run --rm hello-world > /dev/null
  echo "inner hello-world ran"
  docker pull -q alpine > /dev/null
  docker run --rm alpine wget -qO /dev/null -T 15 https://example.com \
    || { echo "no egress from an inner container on the default bridge"; exit 1; }
  echo "inner bridge egress ok"
  docker network create verify-net > /dev/null
  docker run --rm --network verify-net alpine wget -qO /dev/null -T 15 https://example.com \
    || { echo "no egress/DNS from an inner container on a user-defined network (compose would break)"; exit 1; }
  echo "inner user-defined network egress ok"
  docker run --rm --network=host alpine wget -qO /dev/null -T 15 https://example.com \
    || { echo "no egress with --network=host"; exit 1; }
  echo "inner host-network egress ok"
  mkdir -p /tmp/b && printf "FROM alpine\nRUN echo built > /x\n" > /tmp/b/Dockerfile
  docker build -q /tmp/b > /dev/null || { echo "inner docker build failed"; exit 1; }
  echo "inner docker build ok"
' || fail "inner docker check failed (see output above; dockerd log is /tmp/dockerd.log inside the sandbox)"
ok "inner dockerd starts on tmpfs, is isolated, and its containers have network + build"

echo
echo "All checks passed. Restart the r-docs service to pick up runsc detection:"
echo "  ./manage.sh restart"
