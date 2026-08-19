#!/usr/bin/env bash
# Service management entry point for r-docs, invoked by ../manager.sh
# (which delegates here) or directly: ./manage.sh <start|stop|restart|status|logs>
#
# This service does NOT fit manager.sh's PID-file model: it runs as a Caddy
# load balancer on :14141 in front of blue/green app instances on
# :14142/:14143 (see deploy/README.md). "restart" here means a zero-downtime
# blue/green deploy, not kill-and-relaunch — killing the :14141 listener
# would take down the LB while the app keeps running unreachable behind it.
set -euo pipefail
cd "$(dirname "$0")"

COMMAND="${1:-}"

LB_PORT=14141
BLUE_PORT=14142
GREEN_PORT=14143

listeners() { lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true; }

health() { curl -sf --max-time 5 "http://localhost:$LB_PORT/api/health" 2>/dev/null || true; }

deploy() {
    # deploy.sh builds the inactive color, health-checks it, switches the
    # Caddy upstream, and drains the old process. If nothing is running it
    # bootstraps the whole stack. Zero-downtime either way (except the very
    # first bootstrap over a legacy single-process server).
    ./deploy/deploy.sh
}

start_service() {
    H="$(health)"
    if [ -n "$H" ]; then
        echo "r-docs is already serving on :$LB_PORT: $H"
        echo "Use './manage.sh restart' to deploy the current code."
        exit 0
    fi
    deploy
}

stop_service() {
    echo "Stopping r-docs (LB on :$LB_PORT, apps on :$BLUE_PORT/:$GREEN_PORT)..."
    # LB first so no traffic reaches the apps while they shut down.
    for PORT in "$LB_PORT" "$BLUE_PORT" "$GREEN_PORT"; do
        PIDS="$(listeners "$PORT")"
        if [ -n "$PIDS" ]; then
            echo "  killing :$PORT listener(s): $PIDS"
            # shellcheck disable=SC2086
            kill $PIDS 2>/dev/null || true
        fi
    done
    sleep 2
    for PORT in "$LB_PORT" "$BLUE_PORT" "$GREEN_PORT"; do
        PIDS="$(listeners "$PORT")"
        if [ -n "$PIDS" ]; then
            echo "  force killing :$PORT listener(s): $PIDS"
            # shellcheck disable=SC2086
            kill -9 $PIDS 2>/dev/null || true
        fi
    done
    # SIGTERM-surviving next-server processes can keep serving over
    # established keep-alive connections even without a listener.
    for PORT in "$LB_PORT" "$BLUE_PORT" "$GREEN_PORT"; do
        STALE=$(lsof -nP -iTCP:"$PORT" -sTCP:ESTABLISHED 2>/dev/null | awk -v pat=":$PORT->" 'NR>1 && index($9, pat) > 0 {print $2}' | sort -u || true)
        # shellcheck disable=SC2086
        [ -n "$STALE" ] && kill -9 $STALE 2>/dev/null || true
    done
    rm -f .lb.pid .service_blue.pid .service_green.pid .service.pid
    echo "r-docs stopped."
}

show_status() {
    H="$(health)"
    if [ -n "$H" ]; then
        echo "r-docs is running: $H"
    else
        echo "r-docs is NOT serving on :$LB_PORT"
    fi
    ACTIVE="$(cat .deploy-active 2>/dev/null || echo '?')"
    echo "active color: $ACTIVE"
    for LABEL_PORT in "lb:$LB_PORT" "blue:$BLUE_PORT" "green:$GREEN_PORT"; do
        LABEL="${LABEL_PORT%%:*}"; PORT="${LABEL_PORT##*:}"
        PIDS="$(listeners "$PORT")"
        if [ -n "$PIDS" ]; then
            echo "  $LABEL (:$PORT): up (pid $PIDS)"
        else
            echo "  $LABEL (:$PORT): down"
        fi
    done
    LATEST_LOG=$(ls -t logs/service_*.log 2>/dev/null | head -1)
    if [ -n "$LATEST_LOG" ]; then
        echo ""
        echo "Latest log: $LATEST_LOG"
        tail -5 "$LATEST_LOG" | sed 's/^/  /'
    fi
}

view_logs() {
    LATEST_LOG=$(ls -t logs/service_*.log 2>/dev/null | head -1)
    if [ -z "$LATEST_LOG" ]; then
        echo "No log files found in logs/"
        exit 1
    fi
    echo "Viewing logs from: $LATEST_LOG"
    echo "Press Ctrl+C to exit"
    echo "----------------------------------------"
    tail -f "$LATEST_LOG"
}

case "$COMMAND" in
    start)   start_service ;;
    stop)    stop_service ;;
    restart) deploy ;;
    status)  show_status ;;
    logs)    view_logs ;;
    *)
        echo "Usage: $0 <start|stop|restart|status|logs>"
        echo "start/restart run a zero-downtime blue/green deploy (deploy/deploy.sh)."
        exit 1
        ;;
esac
