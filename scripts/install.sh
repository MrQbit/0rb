#!/usr/bin/env bash
#
# orb2 — from-scratch installer for the NVIDIA DGX Spark (aarch64 + Blackwell).
# Idempotent: safe to re-run. Brings up the whole Docker Compose stack.
#
#   bash scripts/install.sh
#
# Prerequisites (the script checks + guides you):
#   - Docker Engine + the `docker compose` plugin
#   - NVIDIA Container Toolkit (for the GPU services)
#   - The `personaplex:cuda` base image (the GPU services build FROM it) and a
#     vLLM image — these are heavy and box-specific; see the GPU step below.
#
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"
REG=localhost:5001

say(){ printf '\n\033[1;32m→ %s\033[0m\n' "$*"; }
warn(){ printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }

dk(){ if id -nG | grep -qw docker; then docker "$@"; else sg docker -c "docker $*"; fi; }

# ── 1. prerequisites ──────────────────────────────────────────────────────
command -v docker >/dev/null || { warn "Docker is required: https://docs.docker.com/engine/install/"; exit 1; }
dk compose version >/dev/null 2>&1 || { warn "The 'docker compose' plugin is required."; exit 1; }
if ! dk info 2>/dev/null | grep -qi 'Runtimes:.*nvidia'; then
  warn "NVIDIA container runtime not detected — the GPU services (vllm/tts/stt/vision/embed) need nvidia-container-toolkit."
fi
command -v bun >/dev/null 2>&1 || { say "Installing Bun"; curl -fsSL https://bun.sh/install | bash; export PATH="$HOME/.bun/bin:$PATH"; }

# ── 2. local image registry on :5001 (compose pulls localhost:5001/* here) ──
# registry:2 listens on 5000 inside the container. If something already serves
# :5001 (e.g. a registry from an earlier install), reuse it instead of failing.
if curl -sf http://localhost:5001/v2/ >/dev/null 2>&1; then
  say "A registry is already serving localhost:5001 — reusing it"
elif ! dk ps --format '{{.Names}}' | grep -qx orb2-registry; then
  say "Starting a local image registry on :5001"
  dk run -d --restart=always -p 5001:5000 --name orb2-registry registry:2
fi

# ── 3. .env from template ──────────────────────────────────────────────────
if [ ! -f .env ]; then
  say "Creating .env from .env.example"
  cp .env.example .env
  # Each secret gets its own random value (a single global sed would give the
  # auth secret and the WhatsApp bridge secret the same value).
  while grep -q REPLACE_WITH_RANDOM_SECRET .env; do
    sed -i "0,/REPLACE_WITH_RANDOM_SECRET/s//$(openssl rand -hex 32)/" .env
  done
  sed -i "s|/home/youruser/orb2|$REPO|" .env
  # First sign-in needs a real owner email on the allowlist. Codes are
  # delivered via the hosted relay by default, so email just works.
  if [ -t 0 ]; then
    read -rp "Owner email for sign-in (you@example.com): " OWNER_EMAIL || true
    if [ -n "${OWNER_EMAIL:-}" ]; then
      sed -i "s|ORB2_AUTH_ALLOWED_EMAILS=you@example.com|ORB2_AUTH_ALLOWED_EMAILS=$OWNER_EMAIL|" .env
    fi
  fi
  grep -q 'ORB2_AUTH_ALLOWED_EMAILS=you@example.com' .env && \
    warn "Edit .env: set ORB2_AUTH_ALLOWED_EMAILS to YOUR email or sign-in will be impossible."
  warn "Optional in .env: your own SMTP, Telegram/WhatsApp channels."
fi

# ── 3b. model cache dir (pre-create so Docker doesn't make it root-owned) ──
mkdir -p "$HOME/.cache/orb2-models"
# Migrate models from a pre-rebrand install (hardlinks: same filesystem, no copy).
if [ -d "$HOME/.cache/rak00n-models" ]; then
  for f in "$HOME"/.cache/rak00n-models/*; do
    [ -f "$f" ] && [ ! -e "$HOME/.cache/orb2-models/$(basename "$f")" ] && \
      { ln "$f" "$HOME/.cache/orb2-models/" 2>/dev/null || cp "$f" "$HOME/.cache/orb2-models/"; } && \
      say "Migrated model $(basename "$f") from rak00n-models"
  done
fi

# ── 4. build the images we own (api, ui, whatsapp) ────────────────────────
say "Building the API bundle"
bun run build:api
say "Building + pushing api / ui / whatsapp images"
dk build -t $REG/orb2-api:dev -f Dockerfile.api.dev . && dk push $REG/orb2-api:dev
dk build -t $REG/orb2-ui:dev  -f web/Dockerfile web/    && dk push $REG/orb2-ui:dev
dk build -t $REG/orb2-whatsapp:dev services/whatsapp/   && dk push $REG/orb2-whatsapp:dev

# ── 5. GPU service images (need the personaplex:cuda base) ────────────────
# Pre-rebrand boxes already have these built as rak00n-* — retag, don't rebuild.
for s in tts stt vision embed orpheus; do
  if ! dk image inspect orb2-$s:cuda >/dev/null 2>&1 && dk image inspect rak00n-$s:cuda >/dev/null 2>&1; then
    say "Reusing pre-rebrand image rak00n-$s:cuda as orb2-$s:cuda"
    dk tag rak00n-$s:cuda orb2-$s:cuda
  fi
done
if ! dk image inspect orb2-av-webrtc:latest >/dev/null 2>&1 && dk image inspect rak00n-av-webrtc:latest >/dev/null 2>&1; then
  dk tag rak00n-av-webrtc:latest orb2-av-webrtc:latest
fi
if dk image inspect personaplex:cuda >/dev/null 2>&1; then
  say "Building GPU service images (tts/stt/vision/embed) from personaplex:cuda"
  for s in tts stt vision embed; do dk build -t orb2-$s:cuda services/$s/ || warn "build of $s failed"; done
  dk build -t orb2-av-webrtc:latest services/av-webrtc/ || warn "av-webrtc build failed"
else
  warn "personaplex:cuda base image not found — skipping GPU service builds."
  warn "Build the base + vLLM image for your box first, then re-run, or build the"
  warn "GPU services manually: for s in tts stt vision embed; do docker build -t orb2-\$s:cuda services/\$s/; done"
fi

# ── 6. start the stack ─────────────────────────────────────────────────────
say "Starting the stack"
./scripts/orb2-stack.sh up
./scripts/orb2-stack.sh status

cat <<EOF

✓ orb2 is starting.
  Console:  http://localhost:${ORB2_UI_PORT:-9080}   (HTTPS: https://localhost:${ORB2_UI_HTTPS_PORT:-9443})
  Sign in with an email from ORB2_AUTH_ALLOWED_EMAILS (a code is emailed / Telegrammed).
  Remote access over Tailscale:  bash scripts/setup-tailscale.sh
EOF
