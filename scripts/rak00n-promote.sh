#!/bin/sh
#
# Detached promoter — runs in a standalone docker:cli container so it survives
# rak00n-api recreating itself. Recreates rak00n-api on the new :dev image, health-
# checks it, and rolls back to :prev if it doesn't come up. Then restarts ui
# (nginx) to clear the stale upstream IP.
#
set -e
CF=${RAK00N_COMPOSE_FILE:-docker-compose.spark.yml}
PROJECT=${RAK00N_COMPOSE_PROJECT:-rak00n}
REG=${RAK00N_SELF_REGISTRY:-localhost:5001}
IMG=$REG/rak00n-api
DC="docker compose -p $PROJECT -f $CF"

sleep 3
echo "→ recreating rak00n-api on $IMG:dev"
$DC up -d --force-recreate --pull always rak00n-api || true

ok=0
i=0
while [ "$i" -lt 30 ]; do
  if curl -fsS http://rak00n-api:8080/healthz >/dev/null 2>&1; then ok=1; break; fi
  i=$((i + 1)); sleep 2
done

if [ "$ok" != 1 ]; then
  echo "✗ new prod UNHEALTHY — rolling back to $IMG:prev"
  docker tag "$IMG:prev" "$IMG:dev" || true
  docker push "$IMG:dev" || true
  $DC up -d --force-recreate --pull always rak00n-api || true
else
  echo "✓ new prod healthy"
fi

echo "→ restarting ui (nginx upstream refresh)"
$DC restart ui || true
echo "done"
