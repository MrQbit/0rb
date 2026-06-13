#!/usr/bin/env bash
# Build a new rak00n API image and import it into the k3d cluster so the
# agent can SelfUpdate to it. Invoked by the SelfBuild operator (or by a
# human) with the image tag as $1.
#
# Requires host docker (RAK00N_DOCKER_OPS_ENABLED=1 + mounted socket) and
# the k3d CLI. Override any of these via env:
#   RAK00N_SELF_IMAGE_REPO   image repo            (default rak00n-api)
#   RAK00N_SELF_BUILD_CONTEXT build context dir    (default repo root)
#   RAK00N_SELF_DOCKERFILE   Dockerfile path        (default Dockerfile)
#   RAK00N_SELF_CLUSTER      k3d cluster name       (default rak00n-dev)
set -euo pipefail

TAG=${1:?usage: self-build.sh <tag>}
REPO=${RAK00N_SELF_IMAGE_REPO:-rak00n-api}
CONTEXT=${RAK00N_SELF_BUILD_CONTEXT:-$(cd "$(dirname "$0")/.." && pwd)}
DOCKERFILE=${RAK00N_SELF_DOCKERFILE:-$CONTEXT/Dockerfile}
CLUSTER=${RAK00N_SELF_CLUSTER:-rak00n-dev}
IMAGE="${REPO}:${TAG}"

echo "→ building $IMAGE (context=$CONTEXT)"
docker build -f "$DOCKERFILE" -t "$IMAGE" "$CONTEXT"

echo "→ importing $IMAGE into k3d cluster '$CLUSTER'"
k3d image import "$IMAGE" -c "$CLUSTER"

echo "IMAGE=$IMAGE"
