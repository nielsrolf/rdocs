# Sourced by deploy.sh (and tests/deploy-port-listeners.test.ts). Helpers for
# "who holds this TCP port?".

# True if anything listens on TCP port $1. Needs no access to the owning
# process, so it is the ONLY safe test for "is this port free / is there an
# old color to drain".
port_in_use() {
  [ -n "$(ss -tlnH "sport = :$1" 2>/dev/null)" ]
}

# PIDs listening on a TCP port. lsof is NOT trustworthy on this host: it fails
# to stat a docker netns and silently omits the next-server listeners entirely
# (2026-08-23: a zombie green held :14143, lsof reported nothing, the new green
# died EADDRINUSE, and the health poll switched traffic to the 2-day-old
# zombie). ss reads /proc/net directly and sees them.
# The trailing `|| true` matters: under `set -euo pipefail` a FREE port makes
# grep match nothing → pipeline exit 1 → the $(…) assignment kills the script
# silently (this happened on the first run of this helper).
# CAVEAT: ss can only NAME the pid when it may read /proc/<pid>/fd, which
# requires the same uid AND the same primary gid. An empty result therefore
# does not mean the port is free — use port_in_use for that.
port_listeners() {
  ss -tlnpH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true
}

# PIDs of the APP listening on a color port. Falls back to the pid the app
# reports on /api/health when ss shows a listener it cannot name: a deploy
# re-executed under `sg docker` has docker as primary gid and is blind to a
# color started with gid niels, and vice versa. That blindness skipped the
# drain of the old color and then failed every later deploy with EADDRINUSE on
# the port it still held (2026-11-10). Only for the color ports — on the LB
# port /api/health is answered by the app BEHIND Caddy, not the listener.
app_port_listeners() {
  local pids
  pids=$(port_listeners "$1")
  if [ -z "$pids" ] && port_in_use "$1"; then
    pids=$(curl -s -m 5 "http://localhost:$1/api/health" 2>/dev/null | grep -o '"pid":[0-9]*' | cut -d: -f2 | head -1 || true)
  fi
  echo "$pids"
}
