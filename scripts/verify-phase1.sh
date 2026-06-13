#!/usr/bin/env bash
# Phase 1 verification: RBAC + worker/canvas/sandbox + cluster API
# Run this on the DGX Spark after: make spark
set -euo pipefail

NS=${NAMESPACE:-rak00n}
API_PORT=${API_PORT:-9080}
PASS=0; FAIL=0

ok()   { echo "  ✓ $1"; ((PASS++)) || true; }
fail() { echo "  ✗ $1"; ((FAIL++)) || true; }
h()    { echo ""; echo "── $1 ──────────────────────────────────────"; }

# Port-forward in background if not already forwarded
if ! curl -sf "http://localhost:${API_PORT}/healthz" >/dev/null 2>&1; then
  echo "→ Starting port-forward on :${API_PORT}..."
  kubectl -n "$NS" port-forward svc/rak00n-api "${API_PORT}:8080" &
  PF_PID=$!
  trap 'kill $PF_PID 2>/dev/null || true' EXIT
  sleep 3
fi

h "RBAC resources"
kubectl -n "$NS" get serviceaccount rak00n-api -o name 2>/dev/null \
  && ok "ServiceAccount rak00n-api exists" || fail "ServiceAccount rak00n-api MISSING"
kubectl -n "$NS" get role rak00n-api -o name 2>/dev/null \
  && ok "Role rak00n-api exists" || fail "Role rak00n-api MISSING"
kubectl -n "$NS" get rolebinding rak00n-api -o name 2>/dev/null \
  && ok "RoleBinding rak00n-api exists" || fail "RoleBinding rak00n-api MISSING"

h "Deployments + Replicas"
REPLICAS=$(kubectl -n "$NS" get deploy rak00n-api -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 0)
[ "$REPLICAS" -ge 2 ] \
  && ok "rak00n-api has $REPLICAS replicas (≥2 for blue-green)" \
  || fail "rak00n-api has only $REPLICAS replica(s) — needs ≥2 for rolling self-update"

READY=$(kubectl -n "$NS" get deploy rak00n-api -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)
[ "$READY" -ge 1 ] \
  && ok "rak00n-api $READY/${REPLICAS} ready" \
  || fail "rak00n-api not ready"

STRATEGY=$(kubectl -n "$NS" get deploy rak00n-api -o jsonpath='{.spec.strategy.rollingUpdate.maxUnavailable}' 2>/dev/null || echo "?")
[ "$STRATEGY" = "0" ] \
  && ok "rollingUpdate.maxUnavailable=0 (blue-green safe)" \
  || fail "rollingUpdate.maxUnavailable=$STRATEGY (expected 0)"

h "Worker env vars"
WORKER_MODE=$(kubectl -n "$NS" exec deploy/rak00n-api -- sh -c 'echo $RAK00N_WORKER_MODE' 2>/dev/null | tr -d '\r' || echo "")
[ "$WORKER_MODE" = "k8s-jobs" ] \
  && ok "RAK00N_WORKER_MODE=k8s-jobs" \
  || fail "RAK00N_WORKER_MODE='$WORKER_MODE' (expected k8s-jobs)"

WORKER_NS=$(kubectl -n "$NS" exec deploy/rak00n-api -- sh -c 'echo $RAK00N_WORKER_NAMESPACE' 2>/dev/null | tr -d '\r' || echo "")
[ -n "$WORKER_NS" ] \
  && ok "RAK00N_WORKER_NAMESPACE=$WORKER_NS" \
  || fail "RAK00N_WORKER_NAMESPACE not set"

WORKER_IMAGE=$(kubectl -n "$NS" exec deploy/rak00n-api -- sh -c 'echo $RAK00N_WORKER_IMAGE' 2>/dev/null | tr -d '\r' || echo "")
[ -n "$WORKER_IMAGE" ] \
  && ok "RAK00N_WORKER_IMAGE=$WORKER_IMAGE" \
  || fail "RAK00N_WORKER_IMAGE not set"

h "Canvas env vars"
CANVAS_ENABLED=$(kubectl -n "$NS" exec deploy/rak00n-api -- sh -c 'echo $RAK00N_CANVAS_ENABLED' 2>/dev/null | tr -d '\r' || echo "")
[ "$CANVAS_ENABLED" = "1" ] \
  && ok "RAK00N_CANVAS_ENABLED=1" \
  || fail "RAK00N_CANVAS_ENABLED='$CANVAS_ENABLED' (expected 1)"

h "API health"
curl -sf "http://localhost:${API_PORT}/healthz" >/dev/null \
  && ok "GET /healthz → 200" || fail "GET /healthz failed"

curl -sf "http://localhost:${API_PORT}/readyz" >/dev/null \
  && ok "GET /readyz → 200" || fail "GET /readyz failed"

h "In-cluster k8s access"
STATUS=$(curl -sf "http://localhost:${API_PORT}/v1/cluster/status" 2>/dev/null || echo '{}')
IN_CLUSTER=$(echo "$STATUS" | grep -o '"in_cluster":true' || true)
if [ -n "$IN_CLUSTER" ]; then
  ok "GET /v1/cluster/status → in_cluster=true"
  POD_COUNT=$(echo "$STATUS" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d.get("pods",[])))' 2>/dev/null || echo "?")
  ok "  pods listed: $POD_COUNT"
else
  fail "GET /v1/cluster/status → in_cluster=false (KUBERNETES_SERVICE_HOST not set or SA token missing)"
  echo "     raw response: $(echo "$STATUS" | head -c 200)"
fi

h "Tools API"
TOOLS=$(curl -sf "http://localhost:${API_PORT}/v1/tools" 2>/dev/null || echo '{}')
TOOL_COUNT=$(echo "$TOOLS" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d.get("tools",[])))' 2>/dev/null || echo "?")
[ "$TOOL_COUNT" -gt 50 ] \
  && ok "GET /v1/tools → $TOOL_COUNT tools (includes native tools)" \
  || fail "GET /v1/tools → only $TOOL_COUNT tools (expected >50)"

for TOOL in ClusterOps DockerOps SelfUpdate; do
  echo "$TOOLS" | grep -q "\"$TOOL\"" \
    && ok "  tool $TOOL present" \
    || fail "  tool $TOOL MISSING"
done

h "Info"
INFO=$(curl -sf "http://localhost:${API_PORT}/v1/info" 2>/dev/null || echo '{}')
WORKER_MODE_INFO=$(echo "$INFO" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("worker_mode","?"))' 2>/dev/null || echo "?")
ok "  worker_mode in /v1/info: $WORKER_MODE_INFO"

SINGLE_USER=$(echo "$INFO" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("single_user","?"))' 2>/dev/null || echo "?")
ok "  single_user in /v1/info: $SINGLE_USER"

h "RBAC permissions test (from inside cluster)"
# Verify the SA can actually list pods (the k8s API call that matters)
CAN_LIST=$(kubectl -n "$NS" auth can-i list pods \
  --as "system:serviceaccount:${NS}:rak00n-api" 2>/dev/null || echo "no")
[ "$CAN_LIST" = "yes" ] \
  && ok "SA rak00n-api can list pods" \
  || fail "SA rak00n-api CANNOT list pods — RBAC misconfigured"

CAN_CREATE_JOBS=$(kubectl -n "$NS" auth can-i create jobs \
  --as "system:serviceaccount:${NS}:rak00n-api" 2>/dev/null || echo "no")
[ "$CAN_CREATE_JOBS" = "yes" ] \
  && ok "SA rak00n-api can create jobs" \
  || fail "SA rak00n-api CANNOT create jobs"

CAN_PATCH_DEPLOY=$(kubectl -n "$NS" auth can-i patch deployments \
  --as "system:serviceaccount:${NS}:rak00n-api" 2>/dev/null || echo "no")
[ "$CAN_PATCH_DEPLOY" = "yes" ] \
  && ok "SA rak00n-api can patch deployments (self-update)" \
  || fail "SA rak00n-api CANNOT patch deployments — self-update will fail"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Phase 1 results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════════════════════"
[ "$FAIL" -eq 0 ] && echo "  All checks passed — ready for Phase 2" && exit 0
echo "  Fix failures above before proceeding" && exit 1
