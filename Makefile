.PHONY: help dev dev-no-vllm build build-api docker-build docker-build-ui \
       docker-build-canvas push \
       spark spark-status spark-logs spark-down \
       install-service start stop status tunnel-start tunnel-status tailscale-status \
       voice-status \
       test clean ensure-bun ensure-deps

.DEFAULT_GOAL := help

# ── Variables ─────────────────────────────────────────────────────────
IMAGE_NAME    := orb2-api
IMAGE_TAG     ?= dev
API_PORT      ?= 9080
# Used by the lightweight dev stack (docker-compose.yml) only. The Spark
# stack (docker-compose.spark.yml) pins its own brain + revision.
VLLM_MODEL    ?= Qwen/Qwen3-Coder-Next
VLLM_SERVED   ?= qwen3-coder-next
UI_IMAGE      := orb2-ui
UI_PORT       ?= 9081
BUN           := $(shell command -v bun 2>/dev/null || echo "$$HOME/.bun/bin/bun")

help:
	@echo "═══════════════════════════════════════════════════════════════"
	@echo "  orb2 — self-hosted personal AI agent (Docker Compose)"
	@echo "═══════════════════════════════════════════════════════════════"
	@echo ""
	@echo "  The stack (docker-compose.spark.yml):"
	@echo "    make spark            Bring the whole stack up (wraps orb2-stack.sh)"
	@echo "    make spark-status     ps + health"
	@echo "    make spark-logs       Tail the agent API logs"
	@echo "    make spark-down       Stop the stack"
	@echo ""
	@echo "  Local development:"
	@echo "    make dev              Lightweight dev stack: vLLM + Redis + API (docker-compose.yml)"
	@echo "    make dev-no-vllm      Redis + API only (vLLM on host)"
	@echo "    make build            Build CLI bundle (dist/cli.mjs)"
	@echo "    make build-api        Build API bundle (dist/api.mjs)"
	@echo "    make test             Run tests"
	@echo ""
	@echo "  Docker:"
	@echo "    make docker-build     Build API Docker image"
	@echo "    make docker-build-ui  Build UI (console) image"
	@echo "    make push             Tag + push api/ui/canvas to localhost:5001"
	@echo ""
	@echo "  Config:"
	@echo "    VLLM_MODEL=$(VLLM_MODEL)  VLLM_SERVED=$(VLLM_SERVED)  (dev stack only)"
	@echo "    API_PORT=$(API_PORT)"
	@echo ""

# ── Bun auto-install ─────────────────────────────────────────────────
ensure-bun:
	@if ! command -v bun >/dev/null 2>&1 && [ ! -x "$$HOME/.bun/bin/bun" ]; then \
		echo "→ Installing bun..."; \
		curl -fsSL https://bun.sh/install | bash; \
	fi

ensure-deps: ensure-bun
	@if [ ! -d node_modules ]; then \
		echo "→ Installing dependencies..."; \
		$(BUN) install; \
	fi

# ── Build ─────────────────────────────────────────────────────────────
build: ensure-deps
	$(BUN) run scripts/build.ts

build-api: ensure-deps
	$(BUN) run scripts/build-api.ts

# ── Docker ────────────────────────────────────────────────────────────
REGISTRY      ?= localhost:5001
CANVAS_IMAGE  := orb2-canvas

docker-build: build-api
	docker build -t $(IMAGE_NAME):$(IMAGE_TAG) -f Dockerfile.api.dev .

docker-build-ui:
	docker build -t $(UI_IMAGE):$(IMAGE_TAG) -f web/Dockerfile web/

docker-build-canvas:
	docker build -t $(CANVAS_IMAGE):$(IMAGE_TAG) -f Dockerfile.canvas .

# Push all images to the local registry the compose stack pulls from
# (scripts/install.sh starts it on :5001).
push: docker-build docker-build-ui docker-build-canvas
	docker tag $(IMAGE_NAME):$(IMAGE_TAG) $(REGISTRY)/$(IMAGE_NAME):$(IMAGE_TAG)
	docker push $(REGISTRY)/$(IMAGE_NAME):$(IMAGE_TAG)
	docker tag $(UI_IMAGE):$(IMAGE_TAG) $(REGISTRY)/$(UI_IMAGE):$(IMAGE_TAG)
	docker push $(REGISTRY)/$(UI_IMAGE):$(IMAGE_TAG)
	docker tag $(CANVAS_IMAGE):$(IMAGE_TAG) $(REGISTRY)/$(CANVAS_IMAGE):$(IMAGE_TAG)
	docker push $(REGISTRY)/$(CANVAS_IMAGE):$(IMAGE_TAG)
	@echo "✓ All images pushed to $(REGISTRY)"

# ── Local dev (docker compose) ────────────────────────────────────────
dev: build-api
	VLLM_MODEL=$(VLLM_MODEL) VLLM_SERVED_NAME=$(VLLM_SERVED) \
		docker compose up --build

dev-no-vllm: build-api
	docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build

# ── The Spark stack (docker-compose.spark.yml) ────────────────────────
spark:
	./scripts/orb2-stack.sh up

spark-status:
	./scripts/orb2-stack.sh status

spark-logs:
	./scripts/orb2-stack.sh logs orb2-api

spark-down:
	./scripts/orb2-stack.sh down

# ── Test ──────────────────────────────────────────────────────────────
test: ensure-deps
	$(BUN) test src/api/smoke.test.ts src/api/auth/bootstrap.test.ts src/api/control/rateLimit.test.ts

# ── Service management (systemd) ──────────────────────────────────────
install-service:
	@echo "→ Installing the orb2 boot unit..."
	@sudo cp scripts/orb2.service /etc/systemd/system/orb2.service
	@sudo systemctl daemon-reload
	@sudo systemctl enable orb2
	@echo "✓ Service installed. Run: make start"

start:
	sudo systemctl start orb2

stop:
	sudo systemctl stop orb2

status:
	@systemctl status orb2 --no-pager || true
	@echo ""
	@curl -sf http://localhost:$(API_PORT)/v1/status | python3 -m json.tool 2>/dev/null || echo "API not responding"

# ── Remote access ─────────────────────────────────────────────────────
tunnel-start:
	@if [ -f config/cloudflare-tunnel.yml ]; then \
		cloudflared tunnel run --config config/cloudflare-tunnel.yml; \
	else \
		echo "Run scripts/setup-cloudflare-tunnel.sh first"; \
	fi

tunnel-status:
	@cloudflared tunnel list 2>/dev/null || echo "cloudflared not installed"

tailscale-status:
	@tailscale status 2>/dev/null || echo "Tailscale not installed"

# ── Voice ─────────────────────────────────────────────────────────────
# STT/TTS run as GPU compose services (stt :8990, tts :8991) — see
# docker-compose.spark.yml. This just checks the wired-up status.
voice-status:
	@curl -sf http://localhost:$(API_PORT)/v1/voice/status 2>/dev/null | python3 -m json.tool || echo "Voice status unavailable"

# ── Clean ─────────────────────────────────────────────────────────────
clean:
	rm -rf dist/
	@echo "✓ Cleaned dist/"
