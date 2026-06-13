#!/usr/bin/env bash
# Build a new orb2 API image and import it into the k3d cluster so the
# agent can SelfUpdate to it. Invoked by the SelfBuild operator (or by a
# human) with the image tag as $1.
#
# Requires host docker (ORB2_DOCKER_OPS_ENABLED=1 + mounted socket) and
# the k3d CLI. Override any of these via env:
#   ORB2_SELF_IMAGE_REPO   image repo            (default orb2-api)
#   ORB2_SELF_BUILD_CONTEXT build context dir    (default repo root)
#   ORB2_SELF_DOCKERFILE   Dockerfile path        (default Dockerfile)
#   ORB2_SELF_CLUSTER      k3d cluster name       (default orb2-dev)
set -euo pipefail

TAG=${1:?usage: self-build.sh <tag>}
REPO=${ORB2_SELF_IMAGE_REPO:-orb2-api}
CONTEXT=${ORB2_SELF_BUILD_CONTEXT:-$(cd "$(dirname "$0")/.." && pwd)}
DOCKERFILE=${ORB2_SELF_DOCKERFILE:-$CONTEXT/Dockerfile}
CLUSTER=${ORB2_SELF_CLUSTER:-orb2-dev}
IMAGE="${REPO}:${TAG}"

echo "→ building $IMAGE (context=$CONTEXT)"
docker build -f "$DOCKERFILE" -t "$IMAGE" "$CONTEXT"

echo "→ importing $IMAGE into k3d cluster '$CLUSTER'"
k3d image import "$IMAGE" -c "$CLUSTER"

echo "IMAGE=$IMAGE"
