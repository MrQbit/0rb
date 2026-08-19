#!/usr/bin/env bash
#
# orb2 — install for machines WITHOUT a capable NVIDIA GPU
# (Mac via Docker Desktop, Windows via WSL2/Docker Desktop, Raspberry Pi 4/5,
#  any x86 box). The brain runs in the cloud; voice services are skipped.
#
#   bash scripts/install-cloudbrain.sh
#
# Idempotent. Prompts for: owner email, cloud endpoint + key + model.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"

say(){ printf '\n\033[1;32m→ %s\033[0m\n' "$*"; }
warn(){ printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }

command -v docker >/dev/null || { warn "Docker is required (Docker Desktop on Mac/Windows): https://docs.docker.com/get-docker/"; exit 1; }
docker compose version >/dev/null 2>&1 || { warn "The 'docker compose' plugin is required."; exit 1; }
command -v bun >/dev/null 2>&1 || { say "Installing Bun"; curl -fsSL https://bun.sh/install | bash; export PATH="$HOME/.bun/bin:$PATH"; }

bash scripts/preflight.sh || true

if [ ! -f .env ]; then
  say "Creating .env"
  cp .env.example .env
  while grep -q REPLACE_WITH_RANDOM_SECRET .env; do
    sed -i.bak "0,/REPLACE_WITH_RANDOM_SECRET/s//$(openssl rand -hex 32)/" .env && rm -f .env.bak
  done
  sed -i.bak "s|/home/youruser/orb2|$REPO|" .env && rm -f .env.bak
  if [ -t 0 ]; then
    read -rp "Owner email for sign-in: " OWNER_EMAIL || true
    [ -n "${OWNER_EMAIL:-}" ] && { sed -i.bak "s|ORB2_AUTH_ALLOWED_EMAILS=you@example.com|ORB2_AUTH_ALLOWED_EMAILS=$OWNER_EMAIL|" .env; rm -f .env.bak; }
    echo "Cloud brain — pick an OpenAI-compatible endpoint:"
    echo "  1) OpenRouter (one key, many models)   https://openrouter.ai/api/v1"
    echo "  2) OpenAI                              https://api.openai.com/v1"
    echo "  3) Anthropic (OpenAI-compatible)       https://api.anthropic.com/v1"
    read -rp "Choice [1]: " CH || true
    case "${CH:-1}" in
      2) BASE=https://api.openai.com/v1; MODEL_DEFAULT=gpt-4o;;
      3) BASE=https://api.anthropic.com/v1; MODEL_DEFAULT=claude-sonnet-4-6;;
      *) BASE=https://openrouter.ai/api/v1; MODEL_DEFAULT=openai/gpt-4o;;
    esac
    read -rp "API key: " KEY || true
    read -rp "Model id [${MODEL_DEFAULT}]: " MODEL || true
    {
      echo ""
      echo "# Cloud brain (no local GPU)"
      echo "OPENAI_BASE_URL=$BASE"
      echo "OPENAI_API_KEY=${KEY:-}"
      echo "OPENAI_MODEL=${MODEL:-$MODEL_DEFAULT}"
      echo "ORB2_VOICE_ENABLED=0"
    } >> .env
  else
    warn "Non-interactive: edit .env — ORB2_AUTH_ALLOWED_EMAILS, OPENAI_BASE_URL/OPENAI_API_KEY/OPENAI_MODEL, ORB2_VOICE_ENABLED=0."
  fi
fi

say "Building the API bundle + images"
bun run build:api
docker build -t orb2-api:dev -f Dockerfile.api.dev .
docker build -t orb2-ui:dev web/
docker build -t orb2-whatsapp:dev services/whatsapp/

say "Starting the CPU stack (api, ui, redis, searxng, home assistant, whatsapp)"
docker compose -f docker-compose.cloud.yml --env-file .env up -d

cat <<EOF

✓ orb2 is starting (cloud-brain mode).
  Console:  http://localhost:${ORB2_UI_PORT:-9080}
  Sign in with your email — the code arrives from signin@orb2.app.
  Voice needs a local NVIDIA GPU and is off on this machine; everything
  else (chat, widgets, smart home, vision via a cloud vision model) works.
EOF
