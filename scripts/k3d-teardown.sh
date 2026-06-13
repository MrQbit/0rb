#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# rak00n k3d Teardown
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

CLUSTER_NAME="${RAK00N_K3D_CLUSTER:-rak00n-dev}"

echo "→ Uninstalling Helm release..."
helm uninstall rak00n -n rak00n 2>/dev/null || true

if [ "${1:-}" = "--full" ]; then
  echo "→ Deleting k3d cluster '$CLUSTER_NAME'..."
  k3d cluster delete "$CLUSTER_NAME" 2>/dev/null || true
  echo "✓ Cluster deleted"
else
  echo "✓ Release uninstalled (cluster preserved)"
  echo "  To delete the cluster: $0 --full"
fi
