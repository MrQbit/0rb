#!/usr/bin/env bash
#
# rak00n self-evolution: build the agent's own (already-edited) source into a
# candidate image, boot it in a throwaway SANDBOX, health-check it, and only
# if it passes, PROMOTE it to the running prod instance — with automatic
# rollback if the new prod fails to come up healthy.
#
# Runs INSIDE rak00n-api (which has bun + the docker CLI + the repo at /src and
# the docker socket). The final recreate is delegated to a detached docker:cli
# container (rak00n-promote.sh) because rak00n-api can't recreate itself — its
# own process dies mid-command.
#
#   self-evolve.sh            build + sandbox-test only (no prod change)
#   self-evolve.sh --promote  build + sandbox-test, then promote on success
#
set -euo pipefail

SRC=${RAK00N_SELF_SRC:-/src}
COMPOSE_FILE=${RAK00N_COMPOSE_FILE:-docker-compose.spark.yml}
PROJECT=${RAK00N_COMPOSE_PROJECT:-rak00n}
NET=${RAK00N_COMPOSE_NETWORK:-rak00n_default}
REG=${RAK00N_SELF_REGISTRY:-localhost:5001}
IMG=$REG/rak00n-api
PROMOTE=0
[ "${1:-}" = "--promote" ] && PROMOTE=1

cd "$SRC"
echo "→ [1/4] building API bundle (bun run build:api)"
bun run build:api 2>&1 | tail -2

TS=$(date +%s)
CAND=$IMG:cand-$TS
echo "→ [2/4] building + pushing candidate image $CAND"
docker build -q -t "$CAND" -f Dockerfile.api.dev "$SRC" >/dev/null
docker push -q "$CAND" >/dev/null

echo "→ [3/4] sandbox boot + health-check"
docker rm -f rak00n-api-sandbox >/dev/null 2>&1 || true
# Inherit prod's full env so the sandbox boots identically (secret source,
# LLM endpoint, etc.), then override: auth off, and blank the channel tokens
# so the sandbox doesn't start duplicate Telegram/WhatsApp pollers.
docker inspect rak00n-api --format '{{range .Config.Env}}{{println .}}{{end}}' > /tmp/rak-sandbox.env 2>/dev/null || true
docker run -d --name rak00n-api-sandbox --network "$NET" \
  --env-file /tmp/rak-sandbox.env \
  -e RAK00N_API_AUTH_REQUIRED=0 \
  -e RAK00N_TELEGRAM_BOT_TOKEN= \
  -e RAK00N_WHATSAPP_BRIDGE_SECRET= \
  -e RAK00N_SELF_MODIFY_ENABLED=0 \
  "$CAND" >/dev/null

ok=0
for _ in $(seq 1 30); do
  if docker exec rak00n-api-sandbox sh -lc 'curl -fsS http://127.0.0.1:8080/healthz' >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
echo "── sandbox logs (tail) ──"
docker logs rak00n-api-sandbox 2>&1 | tail -15
docker rm -f rak00n-api-sandbox >/dev/null 2>&1 || true

if [ "$ok" != 1 ]; then
  echo "✗ SANDBOX UNHEALTHY — candidate rejected, prod untouched."
  exit 1
fi
echo "✓ sandbox healthy"

if [ "$PROMOTE" != 1 ]; then
  echo "✓ candidate validated: $CAND (not promoted — re-run with --promote to ship)"
  exit 0
fi

echo "→ [4/4] promoting to prod (with rollback safety net)"
# Snapshot the current prod image for rollback.
docker tag "$IMG:dev" "$IMG:prev" 2>/dev/null || true
docker push -q "$IMG:prev" >/dev/null 2>&1 || true
# Make the candidate the new prod tag.
docker tag "$CAND" "$IMG:dev"
docker push -q "$IMG:dev" >/dev/null

# Hand off the recreate to a detached container (rak00n-api is about to restart).
docker rm -f rak00n-promoter >/dev/null 2>&1 || true
docker run -d --name rak00n-promoter --network "$NET" \
  -e RAK00N_COMPOSE_FILE="$COMPOSE_FILE" -e RAK00N_COMPOSE_PROJECT="$PROJECT" -e RAK00N_SELF_REGISTRY="$REG" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$SRC":/src -w /src \
  docker:cli sh /src/scripts/rak00n-promote.sh >/dev/null

echo "✓ promotion launched. rak00n-api will recreate momentarily; if the new"
echo "  image is unhealthy it auto-rolls back to $IMG:prev. Track it with:"
echo "  docker logs -f rak00n-promoter"
