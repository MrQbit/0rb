# Deploying rak00n

rak00n is a persistent personal-assistant service you run on **your own
hardware**. The stack splits into two tiers:

| Tier | Services | Needs an NVIDIA GPU? |
|---|---|---|
| **Model tier** | `vllm` (brain), `tts`, `stt`, `embed` | **Yes** (CUDA) |
| **App tier** | `rak00n-api`, `ui`, `redis`, `searxng`, `whatsapp`, `blender`, `av-webrtc` | No — any Docker host |

Because the brain is pointed by standard OpenAI-compatible env
(`OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_API_KEY`), you can run the model tier
locally **or** point at a remote/cloud model. That gives three deployment modes.

---

## Mode 1 — Full local (most private, no recurring cost)

Everything on one NVIDIA box. Best on a **DGX Spark (GB10)** or any Linux machine
with a recent NVIDIA GPU.

**Requirements:** Docker Engine + `docker compose`, the **NVIDIA Container
Toolkit**, and the CUDA base image the GPU services build from.

```bash
git clone https://github.com/MrQbit/rak00n.git && cd rak00n
bash scripts/install.sh
# edit .env, then:
./scripts/rak00n-stack.sh restart
```

## Mode 2 — Cloud model, app local (for machines with no NVIDIA GPU)

Run the **app tier** locally (Docker Desktop) and point the brain (and
optionally voice/embed) at a remote endpoint. Good for a MacBook, a Windows
laptop without a discrete NVIDIA GPU, or any low-power box.

Set in `.env`:

```ini
# Brain → a remote OpenAI-compatible endpoint:
OPENAI_BASE_URL=https://<your-endpoint>/v1
OPENAI_MODEL=<served-model-name>
OPENAI_API_KEY=<key-if-required>

# Voice/embed → hosted endpoints, or disable voice:
RAK00N_VOICE_ENABLED=0          # or point RAK00N_STT_URL / RAK00N_TTS_URL at hosted STT/TTS
# RAK00N_EMBED_URL=https://<embed-endpoint>
```

Then bring up only the app tier (omit the GPU services):

```bash
docker compose -f docker-compose.spark.yml up -d \
  rak00n-api ui redis searxng whatsapp blender av-webrtc watchdog
```

**Where "the same model in the cloud" comes from** (any OpenAI-compatible URL):
- **Your own Spark over Tailscale** — run Mode 1 on your Spark, expose `:8888`
  on the tailnet, and point a second machine's `OPENAI_BASE_URL` at it.
- **A GPU box / VPS** you rent, running the same vLLM image.
- **A hosting provider** that serves Qwen (e.g. OpenRouter / Together /
  Fireworks). Set `OPENAI_API_KEY` and the provider's model id.

Vision still works in this mode if the remote brain is multimodal (frames are
sent to it as image blocks). 3D (Blender) and web search run locally.

## Mode 3 — Windows with an NVIDIA GPU (full local via WSL2)

A Windows PC with an NVIDIA RTX card can run **everything** like Mode 1:

1. Install **WSL2** + a recent NVIDIA driver (the Windows driver exposes the GPU
   to WSL2 — no separate Linux driver).
2. Install **Docker Desktop** with the **WSL2 backend** and enable GPU support.
3. Inside WSL2, follow Mode 1.

---

## Per-OS notes

### Linux (recommended host)
Native Docker + NVIDIA Container Toolkit. This is the reference platform
(`scripts/install.sh`, `scripts/rak00n.service` for a boot unit).

### macOS (Apple Silicon)
No NVIDIA GPU → **use Mode 2**. Install **Docker Desktop for Mac**, set the
cloud-model env, and bring up the app tier. (A native on-device model via
MLX/Ollama is a possible future backend but is not the CUDA path.)
Run rak00n at login via a **LaunchAgent** that runs `docker compose up -d`.

### Windows
- **With NVIDIA GPU →** Mode 3 (WSL2, full local).
- **Without →** Mode 2 (Docker Desktop + cloud model).
Start at login via **Task Scheduler** (or Docker Desktop "start on login" + a
compose `up` task).

---

## Persistence (run it as a service)

All services use `restart: unless-stopped`, so Docker brings them back on boot.
For a belt-and-suspenders boot unit on Linux:

```bash
sudo cp scripts/rak00n.service /etc/systemd/system/
sudo systemctl enable --now rak00n
```

On macOS use a LaunchAgent; on Windows a Task Scheduler task at logon — each just
runs `docker compose -f docker-compose.spark.yml up -d`.

---

## Remote access

For voice and remote use you need HTTPS (the browser mic requires a secure
context). Publish over your tailnet:

```bash
bash scripts/setup-tailscale.sh            # tailnet-only
bash scripts/setup-tailscale.sh --funnel   # also public
```

Set `RAK00N_PUBLIC_URL` to the resulting `https://<machine>.<tailnet>.ts.net`.
Everything stays behind rak00n's email/Telegram-OTP auth.

> **Cross-platform install scripts** (`install.ps1` for Windows, a macOS helper,
> and a `docker-compose.cloud.yml` override for Mode 2) are on the roadmap; until
> then, follow the per-OS steps above.
