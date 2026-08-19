#!/usr/bin/env bash
# UI smoke runner — Playwright in Docker against the live stack.
#   ORB_SESSION=<token> bash tests/ui/run.sh
# If ORB_SESSION is unset, mints a session with scripts (owner email from .env).
set -euo pipefail
cd "$(dirname "$0")/../.."

BASE="${ORB_BASE:-http://localhost:9080}"
SHOTS="$(pwd)/tests/ui/shots"
mkdir -p "$SHOTS"

if [ -z "${ORB_SESSION:-}" ]; then
  echo "ORB_SESSION not set — minting one via the api container…"
  ORB_SESSION=$(docker exec orb2-api bun -e '
    const { signSession } = await import("/opt/orb2/api.mjs").catch(() => ({}));
    ' 2>/dev/null || true)
  if [ -z "$ORB_SESSION" ]; then
    echo "Could not mint automatically. Sign in once, copy the orb2_session cookie, and run:"
    echo "  ORB_SESSION=<token> bash tests/ui/run.sh"
    exit 2
  fi
fi

docker run --rm --network host \
  -e ORB_SESSION="$ORB_SESSION" -e ORB_BASE="$BASE" -e SHOTS_DIR=/shots \
  -v "$SHOTS":/shots \
  -v "$(pwd)/tests/ui/smoke.mjs":/cap/smoke.mjs \
  mcr.microsoft.com/playwright:v1.49.0-noble \
  sh -c "cd /cap && npm init -y >/dev/null 2>&1 && npm i playwright@1.49.0 >/dev/null 2>&1 && node smoke.mjs"

echo "Screenshots: tests/ui/shots/ — review them, a green run is not enough."
