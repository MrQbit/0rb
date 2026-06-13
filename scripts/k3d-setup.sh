#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# rak00n k3d Full Stack Setup
#
# One command to deploy the entire rak00n stack into a local k3d
# cluster: vLLM (Qwen3-Coder-Next) + Redis + rak00n API.
#
# Usage:
#   ./scripts/k3d-setup.sh
#   ./scripts/k3d-setup.sh --foundry-key=<key> --foundry-url=<url>
#   ./scripts/k3d-setup.sh --model=Qwen/Qwen3-Coder-Next --tp=1
#   ./scripts/k3d-setup.sh --no-vllm   # skip vLLM (running on host)
#
# Prerequisites: docker, k3d, kubectl, helm, bun
# For GPU: NVIDIA Container Toolkit + nvidia-ctk runtime in k3d
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

CLUSTER_NAME="${RAK00N_K3D_CLUSTER:-rak00n-dev}"
CHART_DIR="$(cd "$(dirname "$0")/../deploy/helm/rak00n" && pwd)"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE_NAME="rak00n-api"
IMAGE_TAG="dev"
API_PORT="${RAK00N_API_PORT:-9080}"
VLLM_PORT="${RAK00N_VLLM_PORT:-8000}"

# Defaults
FOUNDRY_KEY=""
FOUNDRY_URL=""
FOUNDRY_RESOURCE=""
VLLM_MODEL="Qwen/Qwen3-Coder-Next"
VLLM_SERVED_NAME="qwen3-coder-next"
VLLM_TP="1"
VLLM_MAX_LEN="32768"
HF_TOKEN=""
SKIP_VLLM=false
SKIP_BUILD=false
GPU_COUNT="all"

for arg in "$@"; do
  case $arg in
    --foundry-key=*)     FOUNDRY_KEY="${arg#*=}" ;;
    --foundry-url=*)     FOUNDRY_URL="${arg#*=}" ;;
    --foundry-resource=*)FOUNDRY_RESOURCE="${arg#*=}" ;;
    --model=*)           VLLM_MODEL="${arg#*=}" ;;
    --served-name=*)     VLLM_SERVED_NAME="${arg#*=}" ;;
    --tp=*)              VLLM_TP="${arg#*=}" ;;
    --max-len=*)         VLLM_MAX_LEN="${arg#*=}" ;;
    --hf-token=*)        HF_TOKEN="${arg#*=}" ;;
    --no-vllm)           SKIP_VLLM=true ;;
    --skip-build)        SKIP_BUILD=true ;;
    --gpu=*)             GPU_COUNT="${arg#*=}" ;;
    --cluster=*)         CLUSTER_NAME="${arg#*=}" ;;
    --port=*)            API_PORT="${arg#*=}" ;;
    -h|--help)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --model=MODEL          HuggingFace model (default: Qwen/Qwen3-Coder-Next)"
      echo "  --served-name=NAME     OpenAI API model name (default: qwen3-coder-next)"
      echo "  --tp=N                 Tensor parallel size (default: 1)"
      echo "  --max-len=N            Max model length (default: 32768)"
      echo "  --hf-token=TOKEN       HuggingFace token for gated models"
      echo "  --gpu=N                GPU count (default: all)"
      echo "  --no-vllm              Skip vLLM (use host vLLM or external)"
      echo "  --skip-build           Skip API image build"
      echo "  --foundry-key=KEY      Anthropic Foundry API key (fallback)"
      echo "  --foundry-url=URL      Anthropic Foundry URL (fallback)"
      echo "  --foundry-resource=RES Anthropic Foundry resource name"
      echo "  --cluster=NAME         k3d cluster name (default: rak00n-dev)"
      echo "  --port=PORT            API port on host (default: 9080)"
      exit 0 ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

echo "═══════════════════════════════════════════════════════════════"
echo "  rak00n — Full Stack k3d Setup"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  Cluster:    $CLUSTER_NAME"
echo "  vLLM:       ${SKIP_VLLM:+DISABLED}${SKIP_VLLM:-$VLLM_MODEL (tp=$VLLM_TP)}"
echo "  Foundry:    ${FOUNDRY_KEY:+CONFIGURED}${FOUNDRY_KEY:-NOT SET}"
echo "  API port:   $API_PORT"
echo ""

# ── 1. Check prerequisites ──────────────────────────────────────────
for cmd in docker k3d kubectl helm; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd is required but not found."
    exit 1
  fi
done

BUN_BIN="$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"
if [ ! -x "$BUN_BIN" ]; then
  echo "WARNING: bun not found. Installing..."
  curl -fsSL https://bun.sh/install | bash || true
  BUN_BIN="$HOME/.bun/bin/bun"
fi

# ── 2. Create k3d cluster (GPU-passthrough) ─────────────────────────
if k3d cluster list 2>/dev/null | grep -q "$CLUSTER_NAME"; then
  echo "✓ Cluster '$CLUSTER_NAME' already exists"
else
  echo "→ Creating k3d cluster '$CLUSTER_NAME'..."
  K3D_ARGS=(
    -p "${API_PORT}:80@loadbalancer"
    --wait
  )
  # GPU passthrough: k3d supports --gpus with NVIDIA runtime
  if [ "$SKIP_VLLM" = false ] && command -v nvidia-smi &>/dev/null; then
    K3D_ARGS+=(--gpus "$GPU_COUNT")
    echo "  (GPU passthrough enabled: $GPU_COUNT)"
  fi
  k3d cluster create "$CLUSTER_NAME" "${K3D_ARGS[@]}"
  echo "✓ Cluster created"
fi

# ── 3. Build rak00n API ─────────────────────────────────────────────
if [ "$SKIP_BUILD" = false ]; then
  echo "→ Building rak00n API..."
  cd "$PROJECT_DIR"
  "$BUN_BIN" install --frozen-lockfile 2>/dev/null || "$BUN_BIN" install
  SKIP_BUILD_SMOKE=1 "$BUN_BIN" run scripts/build-api.ts 2>/dev/null || \
    SKIP_BUILD_SMOKE=1 "$BUN_BIN" run scripts/build.ts

  echo "→ Building Docker image..."
  docker build -t "${IMAGE_NAME}:${IMAGE_TAG}" -f Dockerfile.api.dev .

  echo "→ Importing image into k3d..."
  k3d image import "${IMAGE_NAME}:${IMAGE_TAG}" -c "$CLUSTER_NAME"
fi

# ── 4. Helm install/upgrade ─────────────────────────────────────────
echo "→ Installing Helm chart..."
HELM_SET=(
  --set "global.imageTag=${IMAGE_TAG}"
  --set "global.imagePullPolicy=Never"
  --set "global.imageRepository=${IMAGE_NAME}"
)

# vLLM config
if [ "$SKIP_VLLM" = true ]; then
  HELM_SET+=(--set "vllm.enabled=false")
  # Point to host vLLM
  # Use the k3d network gateway IP directly — host.k3d.internal DNS can break
  # after node restarts. Gateway is always the first IP in the k3d network.
  K3D_GATEWAY=$(docker network inspect "k3d-${CLUSTER_NAME}" --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || echo "172.20.0.1")
  HELM_SET+=(--set "llm.local.baseUrl=http://${K3D_GATEWAY}:${VLLM_PORT}/v1")
else
  HELM_SET+=(--set "vllm.enabled=true")
  HELM_SET+=(--set "vllm.model=${VLLM_MODEL}")
  HELM_SET+=(--set "vllm.servedModelName=${VLLM_SERVED_NAME}")
  HELM_SET+=(--set "vllm.tensorParallelSize=${VLLM_TP}")
  HELM_SET+=(--set "vllm.maxModelLen=${VLLM_MAX_LEN}")
  if [ -n "$HF_TOKEN" ]; then
    HELM_SET+=(--set "vllm.huggingfaceToken=${HF_TOKEN}")
  fi
fi

HELM_SET+=(--set "llm.local.model=${VLLM_SERVED_NAME}")
HELM_SET+=(--set "llm.local.helperModel=${VLLM_SERVED_NAME}")

# Foundry fallback
if [ -n "$FOUNDRY_KEY" ]; then
  HELM_SET+=(--set "llm.foundry.enabled=true")
  HELM_SET+=(--set "llm.foundry.apiKey=${FOUNDRY_KEY}")
fi
if [ -n "$FOUNDRY_URL" ]; then
  HELM_SET+=(--set "llm.foundry.baseUrl=${FOUNDRY_URL}")
fi
if [ -n "$FOUNDRY_RESOURCE" ]; then
  HELM_SET+=(--set "llm.foundry.resource=${FOUNDRY_RESOURCE}")
fi

helm upgrade --install rak00n "$CHART_DIR" \
  "${HELM_SET[@]}" \
  --wait --timeout 300s

# ── 5. Wait for rollout ─────────────────────────────────────────────
echo "→ Waiting for pods..."
kubectl -n rak00n rollout status deploy/rak00n-api --timeout=120s
kubectl -n rak00n rollout status statefulset/rak00n-redis --timeout=60s 2>/dev/null || true

if [ "$SKIP_VLLM" = false ]; then
  echo "→ Waiting for vLLM (this may take a few minutes for model download)..."
  kubectl -n rak00n rollout status deploy/rak00n-vllm --timeout=600s 2>/dev/null || \
    echo "  (vLLM still loading model — check: kubectl -n rak00n logs deploy/rak00n-vllm -f)"
fi

# ── 6. Summary ───────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  rak00n is running!"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  API:      kubectl -n rak00n port-forward svc/rak00n-api ${API_PORT}:8080 &"
echo "            curl http://localhost:${API_PORT}/healthz"
echo ""
if [ "$SKIP_VLLM" = false ]; then
echo "  vLLM:     kubectl -n rak00n port-forward svc/rak00n-vllm ${VLLM_PORT}:8000 &"
echo "            curl http://localhost:${VLLM_PORT}/v1/models"
echo ""
fi
echo "  Chat:     curl -X POST http://localhost:${API_PORT}/v1/chat \\
              -H 'Content-Type: application/json' \\
              -d '{\"message\": \"Hello rak00n!\", \"model\": \"${VLLM_SERVED_NAME}\"}'"
echo ""
echo "  Pods:     kubectl -n rak00n get pods"
echo "  Logs:     kubectl -n rak00n logs deploy/rak00n-api -f"
echo "  Teardown: ./scripts/k3d-teardown.sh"
echo ""
