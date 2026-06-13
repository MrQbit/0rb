#!/bin/sh
#
# Detached promoter — runs in a standalone docker:cli container so it survives
# orb2-api recreating itself. Recreates orb2-api on the new :dev image, health-
# checks it, and rolls back to :prev if it doesn't come up. Then restarts ui
# (nginx) to clear the stale upstream IP.
#
set -e
CF=${ORB2_COMPOSE_FILE:-docker-compose.spark.yml}
PROJECT=${ORB2_COMPOSE_PROJECT:-orb2}
REG=${ORB2_SELF_REGISTRY:-localhost:5001}
IMG=$REG/orb2-api
DC="docker compose -p $PROJECT -f $CF"

sleep 3
echo "→ recreating orb2-api on $IMG:dev"
$DC up -d --force-recreate --pull always orb2-api || true

ok=0
i=0
while [ "$i" -lt 30 ]; do
  if curl -fsS http://orb2-api:8080/healthz >/dev/null 2>&1; then ok=1; break; fi
  i=$((i + 1)); sleep 2
done

if [ "$ok" != 1 ]; then
  echo "✗ new prod UNHEALTHY — rolling back to $IMG:prev"
  docker tag "$IMG:prev" "$IMG:dev" || true
  docker push "$IMG:dev" || true
  $DC up -d --force-recreate --pull always orb2-api || true
else
  echo "✓ new prod healthy"
fi

echo "→ restarting ui (nginx upstream refresh)"
$DC restart ui || true
echo "done"
