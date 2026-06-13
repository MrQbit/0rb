#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# orb2 k3d Teardown
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

CLUSTER_NAME="${ORB2_K3D_CLUSTER:-orb2-dev}"

echo "→ Uninstalling Helm release..."
helm uninstall orb2 -n orb2 2>/dev/null || true

if [ "${1:-}" = "--full" ]; then
  echo "→ Deleting k3d cluster '$CLUSTER_NAME'..."
  k3d cluster delete "$CLUSTER_NAME" 2>/dev/null || true
  echo "✓ Cluster deleted"
else
  echo "✓ Release uninstalled (cluster preserved)"
  echo "  To delete the cluster: $0 --full"
fi
