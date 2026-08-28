#!/usr/bin/env bash
# The playbook walkthrough (SPEC Stage 7 release test): the standing
# user-flow checks run back to back against the LIVE stack — every diary
# beat that has a scripted equivalent, asserted in one pass.
#   ORB_SESSION=<token> bash tests/ui/run-walkthrough.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
SHOTS="$(pwd)/tests/ui/shots"
PW=mcr.microsoft.com/playwright:v1.49.0-noble
run(){ name=$1; file=$2
  echo "── $name"
  docker run --rm --network host -e ORB_SESSION="${ORB_SESSION:?set ORB_SESSION}" -e ORB_BASE=http://localhost:9080 -e SHOTS_DIR=/shots \
    -v "$SHOTS":/shots -v "$(pwd)/tests/ui/$file":/cap/check.mjs "$PW" \
    sh -c "cd /cap && npm i playwright@1.49.0 >/dev/null 2>&1 && node check.mjs" && echo "   PASS" || { echo "   FAIL"; FAILED=1; }
}
FAILED=0
run "morning: deck + customize"          deck-check.mjs
run "trust: lock approval + undo"        lock-approval-check.mjs
run "commerce: order → approve → deliver" order-e2e-check.mjs
run "media: TV + Spotify surfaces"       agent-media-check.mjs
run "household: profiles + invite"       profiles-check.mjs
[ "$FAILED" = "0" ] && echo "WALKTHROUGH: every beat green" || echo "WALKTHROUGH: failures above"
exit $FAILED
