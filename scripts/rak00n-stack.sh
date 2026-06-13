#!/usr/bin/env bash
# rak00n stack control — thin wrapper over docker compose for the
# single-user Spark stack. Keeps the compose file path in one place.
#
#   ./scripts/rak00n-stack.sh up        # start the whole stack
#   ./scripts/rak00n-stack.sh down      # stop + remove
#   ./scripts/rak00n-stack.sh restart [svc]
#   ./scripts/rak00n-stack.sh status    # ps + health
#   ./scripts/rak00n-stack.sh logs [svc]
#   ./scripts/rak00n-stack.sh heal      # tail the watchdog's healing log
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE="docker compose -f docker-compose.spark.yml"

# Use the docker group if the current shell isn't already in it.
dc() { if id -nG | grep -qw docker; then $COMPOSE "$@"; else sg docker -c "$COMPOSE $*"; fi; }

case "${1:-status}" in
  up)       dc up -d --remove-orphans ;;
  down)     dc down ;;
  restart)  dc restart ${2:-} ;;
  status)   dc ps ;;
  logs)     dc logs -f --tail=100 ${2:-} ;;
  heal)     dc exec watchdog tail -f /var/log/rak00n/watchdog.log ;;
  *)        echo "usage: $0 {up|down|restart [svc]|status|logs [svc]|heal}"; exit 1 ;;
esac
