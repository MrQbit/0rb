#!/usr/bin/env bash
# Widget gallery audit — every widget type, rendered + screenshotted.
#   ORB_SESSION=<token> bash tests/ui/run-gallery.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
SHOTS="$(pwd)/tests/ui/shots/gallery"
mkdir -p "$SHOTS"
docker run --rm --network host \
  -e ORB_SESSION="${ORB_SESSION:?set ORB_SESSION}" -e ORB_BASE="${ORB_BASE:-http://localhost:9080}" -e SHOTS_DIR=/shots \
  -v "$SHOTS":/shots \
  -v "$(pwd)/tests/ui/gallery.mjs":/cap/gallery.mjs \
  -v "$(pwd)/tests/ui/fixtures.mjs":/cap/fixtures.mjs \
  mcr.microsoft.com/playwright:v1.49.0-noble \
  sh -c "cd /cap && npm init -y >/dev/null 2>&1 && npm i playwright@1.49.0 >/dev/null 2>&1 && node gallery.mjs"
echo "Shots: tests/ui/shots/gallery/ — review every one."

# Plugin sandbox: a runtime plugin must render inside its CSP-locked frame
# (postMessage-only, no network). Fails the run if the frame is empty or leaky.
docker run --rm --network host \
  -e ORB_SESSION="$ORB_SESSION" -e ORB_BASE="${ORB_BASE:-http://localhost:9080}" -e SHOTS_DIR=/shots \
  -v "$SHOTS":/shots \
  -v "$(pwd)/tests/ui/plugin-check.mjs":/cap/check.mjs \
  mcr.microsoft.com/playwright:v1.49.0-noble \
  sh -c "cd /cap && npm init -y >/dev/null 2>&1 && npm i playwright@1.49.0 >/dev/null 2>&1 && node check.mjs"
