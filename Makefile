.PHONY: help dev dev-no-vllm build build-api docker-build docker-build-ui \
       spark spark-forward spark-status spark-logs spark-teardown \
       k3d k3d-build k3d-deploy k3d-status k3d-logs k3d-teardown k3d-port-forward \
       install-service start stop status tunnel-start tunnel-status tailscale-status \
       voice-setup voice-setup-personaplex voice-start-personaplex voice-status \
       verify-phase1 \
       test smoke clean

.DEFAULT_GOAL := help

# ── Variables ─────────────────────────────────────────────────────────
IMAGE_NAME    := rak00n-api
IMAGE_TAG     ?= dev
API_PORT      ?= 9080
VLLM_PORT     ?= 8000
VLLM_MODEL    ?= Qwen/Qwen3-Coder-Next
VLLM_SERVED   ?= qwen3-coder-next
CLUSTER_NAME  ?= rak00n-dev
# Host vLLM URL (for DGX Spark where vLLM runs natively)
VLLM_HOST_URL ?= http://host.k3d.internal:$(VLLM_PORT)/v1
UI_IMAGE      := rak00n-ui
UI_PORT       ?= 9081
BUN           := $(shell command -v bun 2>/dev/null || echo "$$HOME/.bun/bin/bun")

help:
	@echo "═══════════════════════════════════════════════════════════════"
	@echo "  rak00n — Personal AI Coding Agent (DGX Spark)"
	@echo "═══════════════════════════════════════════════════════════════"
	@echo ""
	@echo "  DGX Spark (vLLM already running on host):"
	@echo "    make spark            k3d cluster + Redis + API + UI (uses host vLLM)"
	@echo "    make spark-forward    Port-forward UI + API to host"
	@echo "    make spark-status     Show pods + services"
	@echo "    make spark-logs       Tail API logs"
	@echo "    make spark-teardown   Teardown cluster"
	@echo ""
	@echo "  Local development:"
	@echo "    make dev              Full stack: vLLM + Redis + API (docker compose)"
	@echo "    make dev-no-vllm      Redis + API only (vLLM on host)"
	@echo "    make build            Build CLI bundle (dist/cli.mjs)"
	@echo "    make build-api        Build API bundle (dist/api.mjs)"
	@echo "    make test             Run tests"
	@echo "    make smoke            Build + version check"
	@echo "    make verify-phase1    Verify cluster backbone (RBAC/worker/canvas)"
	@echo ""
	@echo "  Kubernetes (k3d) — full stack including vLLM in cluster:"
	@echo "    make k3d              One-command: create cluster + deploy all"
	@echo "    make k3d-build        Build + import Docker image into k3d"
	@echo "    make k3d-deploy       Helm upgrade in existing cluster"
	@echo "    make k3d-status       Show pods + services"
	@echo "    make k3d-logs         Tail API logs"
	@echo "    make k3d-port-forward Port-forward API + vLLM to host"
	@echo "    make k3d-teardown     Uninstall release (--full to delete cluster)"
	@echo ""
	@echo "  Docker:"
	@echo "    make docker-build     Build API Docker image"
	@echo ""
	@echo "  Config:"
	@echo "    VLLM_MODEL=$(VLLM_MODEL)  VLLM_SERVED=$(VLLM_SERVED)"
	@echo "    VLLM_PORT=$(VLLM_PORT)  API_PORT=$(API_PORT)"
	@echo "    VLLM_HOST_URL=$(VLLM_HOST_URL)"
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
CANVAS_IMAGE  := rak00n-canvas

docker-build: build-api
	docker build -t $(IMAGE_NAME):$(IMAGE_TAG) -f Dockerfile.api.dev .

docker-build-ui:
	docker build -t $(UI_IMAGE):$(IMAGE_TAG) -f web/Dockerfile web/

docker-build-canvas:
	docker build -t $(CANVAS_IMAGE):$(IMAGE_TAG) -f Dockerfile.canvas .

# Push all images to the internal cluster registry (localhost:5001)
push: docker-build docker-build-ui docker-build-canvas
	docker tag $(IMAGE_NAME):$(IMAGE_TAG) $(REGISTRY)/$(IMAGE_NAME):$(IMAGE_TAG)
	docker push $(REGISTRY)/$(IMAGE_NAME):$(IMAGE_TAG)
	docker tag $(UI_IMAGE):$(IMAGE_TAG) $(REGISTRY)/$(UI_IMAGE):$(IMAGE_TAG)
	docker push $(REGISTRY)/$(UI_IMAGE):$(IMAGE_TAG)
	docker tag $(CANVAS_IMAGE):$(IMAGE_TAG) $(REGISTRY)/$(CANVAS_IMAGE):$(IMAGE_TAG)
	docker push $(REGISTRY)/$(CANVAS_IMAGE):$(IMAGE_TAG)
	@echo "✓ All images pushed to $(REGISTRY)"

# Create internal registry and connect to cluster (one-time setup)
registry:
	k3d registry create rak00n-registry --port 5001 || true
	docker network connect k3d-rak00n-dev k3d-rak00n-registry || true
	@echo "✓ Registry at localhost:5001"

# ── Local dev (docker compose) ────────────────────────────────────────
dev: build-api
	VLLM_MODEL=$(VLLM_MODEL) VLLM_SERVED_NAME=$(VLLM_SERVED) \
		docker compose up --build

dev-no-vllm: build-api
	docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build

# ── DGX Spark (vLLM on host, everything else in k3d) ──────────────────
spark: build-api docker-build docker-build-ui
	@echo "═══════════════════════════════════════════════════════════════"
	@echo "  rak00n — DGX Spark mode"
	@echo "  vLLM on host → k3d (Redis + API + UI console)"
	@echo "═══════════════════════════════════════════════════════════════"
	@# 1. Create cluster if needed (expose API and UI ports)
	@if ! k3d cluster list 2>/dev/null | grep -q "$(CLUSTER_NAME)"; then \
		echo "→ Creating k3d cluster '$(CLUSTER_NAME)'..."; \
		k3d cluster create $(CLUSTER_NAME) \
			-p "$(API_PORT):80@loadbalancer" \
			-p "$(UI_PORT):8081@loadbalancer" \
			--wait; \
	else \
		echo "✓ Cluster '$(CLUSTER_NAME)' already exists"; \
	fi
	@# 2. Import images
	@echo "→ Importing images into k3d..."
	@k3d image import $(IMAGE_NAME):$(IMAGE_TAG) -c $(CLUSTER_NAME)
	@k3d image import $(UI_IMAGE):$(IMAGE_TAG) -c $(CLUSTER_NAME)
	@# 3. Helm deploy — no vLLM pod, point API at host vLLM, enable UI
	@echo "→ Deploying Redis + API + UI (vLLM on host at $(VLLM_HOST_URL))..."
	helm upgrade --install rak00n deploy/helm/rak00n \
		--set global.imageTag=$(IMAGE_TAG) \
		--set global.imagePullPolicy=Never \
		--set global.imageRepository=$(IMAGE_NAME) \
		--set vllm.enabled=false \
		--set llm.defaultProvider=local \
		--set llm.local.baseUrl=$(VLLM_HOST_URL) \
		--set llm.local.model=$(VLLM_SERVED) \
		--set llm.local.helperModel=$(VLLM_SERVED) \
		--set ui.enabled=true \
		--set ui.image.repository=$(UI_IMAGE) \
		--set ui.image.tag=$(IMAGE_TAG) \
		--set ui.image.pullPolicy=Never \
		--wait --timeout 120s
	@# 4. Wait
	@kubectl -n rak00n rollout status deploy/rak00n-api --timeout=120s
	@kubectl -n rak00n rollout status deploy/rak00n-ui --timeout=60s
	@echo ""
	@echo "═══════════════════════════════════════════════════════════════"
	@echo "  rak00n is running! (DGX Spark mode)"
	@echo "═══════════════════════════════════════════════════════════════"
	@echo ""
	@echo "  Console: kubectl -n rak00n port-forward svc/rak00n-ui $(UI_PORT):80 &"
	@echo "           then open http://localhost:$(UI_PORT)"
	@echo ""
	@echo "  API:     kubectl -n rak00n port-forward svc/rak00n-api $(API_PORT):8080 &"
	@echo "           curl http://localhost:$(API_PORT)/healthz"
	@echo ""
	@echo "  vLLM:    $(VLLM_HOST_URL) (on host)"
	@echo ""
	@echo "  Quick:   make spark-forward  (port-forward both API + UI)"
	@echo "  Pods:    make spark-status"
	@echo "  Logs:    make spark-logs"
	@echo "  Stop:    make spark-teardown"
	@echo ""

spark-forward:
	@echo "→ Port-forwarding UI → localhost:$(UI_PORT), API → localhost:$(API_PORT)"
	@kubectl -n rak00n port-forward svc/rak00n-ui $(UI_PORT):80 &
	@kubectl -n rak00n port-forward svc/rak00n-api $(API_PORT):8080 &
	@echo ""
	@echo "  Console: http://localhost:$(UI_PORT)"
	@echo "  API:     http://localhost:$(API_PORT)"
	@echo "  Stop:    kill %1 %2"

spark-status: k3d-status

spark-logs: k3d-logs

spark-teardown: k3d-teardown

# ── k3d (full stack in Kubernetes, vLLM included) ─────────────────────
k3d:
	./scripts/k3d-setup.sh --model=$(VLLM_MODEL) --served-name=$(VLLM_SERVED)

k3d-build: build-api docker-build
	k3d image import $(IMAGE_NAME):$(IMAGE_TAG) -c $(CLUSTER_NAME)

k3d-deploy:
	helm upgrade --install rak00n deploy/helm/rak00n \
		--set global.imageTag=$(IMAGE_TAG) \
		--set global.imagePullPolicy=Never \
		--set global.imageRepository=$(IMAGE_NAME) \
		--set vllm.model=$(VLLM_MODEL) \
		--set vllm.servedModelName=$(VLLM_SERVED) \
		--set llm.local.model=$(VLLM_SERVED) \
		--wait --timeout 300s

k3d-status:
	@kubectl -n rak00n get pods,svc,deploy,statefulset 2>/dev/null || \
		echo "No rak00n namespace found. Run: make k3d"

k3d-logs:
	kubectl -n rak00n logs deploy/rak00n-api -f

k3d-port-forward:
	@echo "→ Port-forwarding API → localhost:$(API_PORT), vLLM → localhost:$(VLLM_PORT)"
	@kubectl -n rak00n port-forward svc/rak00n-api $(API_PORT):8080 &
	@kubectl -n rak00n port-forward svc/rak00n-vllm $(VLLM_PORT):8000 2>/dev/null &
	@echo "  API:  http://localhost:$(API_PORT)"
	@echo "  vLLM: http://localhost:$(VLLM_PORT)"
	@echo "  Stop: kill %1 %2"

k3d-teardown:
	./scripts/k3d-teardown.sh

# ── Test ──────────────────────────────────────────────────────────────
test: ensure-deps
	$(BUN) test src/api/smoke.test.ts src/api/auth/bootstrap.test.ts src/api/control/rateLimit.test.ts

smoke: ensure-deps
	$(BUN) run scripts/smoke-test.ts

verify-phase1:
	@bash scripts/verify-phase1.sh

# ── Service management (systemd) ──────────────────────────────────────
install-service: build-api
	@echo "→ Installing rakoon systemd service..."
	@install -d /etc/rakoon /var/log/rakoon
	@cp scripts/rakoon.service /etc/systemd/system/rakoon.service
	@install -d /opt/rakoon
	@cp dist/api.mjs /opt/rakoon/dist/api.mjs 2>/dev/null || cp -r dist /opt/rakoon/
	@systemctl daemon-reload
	@systemctl enable rakoon
	@echo "✓ Service installed. Run: make start"
	@echo "  Edit /etc/rakoon/env with your environment variables."

start:
	systemctl start rakoon

stop:
	systemctl stop rakoon

status:
	@systemctl status rakoon
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

# ── Voice / PersonaPlex ───────────────────────────────────────────────
# Default voice stack: local whisper.cpp (STT) + Piper (TTS).
voice-setup:
	bash scripts/install-whisper.sh

# Optional full-duplex backend (RAK00N_VOICE_BACKEND=personaplex).
voice-setup-personaplex:
	bash scripts/install-personaplex.sh

voice-start-personaplex:
	bash scripts/start-personaplex.sh

voice-status:
	@curl -sf http://localhost:9080/v1/voice/status 2>/dev/null | python3 -m json.tool || echo "Voice status unavailable"

# ── Clean ─────────────────────────────────────────────────────────────
clean:
	rm -rf dist/
	@echo "✓ Cleaned dist/"
