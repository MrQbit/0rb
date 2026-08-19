# Deploying 0rb

0rb is a persistent personal-assistant service you run on **your own
hardware**. The stack splits into two tiers:

| Tier | Services | Needs an NVIDIA GPU? |
|---|---|---|
| **Model tier** | `vllm` (brain), `stt`, `tts`, `orpheus-llama`, `embed` | **Yes** (CUDA) |
| **App tier** | `orb2-api`, `ui`, `redis`, `searxng`, `whatsapp`, `blender`, `av-webrtc`, `homeassistant`, `watchdog` | No — any Docker host |

Because the brain is pointed by standard OpenAI-compatible env
(`OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_API_KEY`), you can run the model
tier locally **or** point at a cloud model. Two hard rules shape every
deployment:

1. **Voice requires the local GPU services.** STT/TTS are GPU compose
   services; they do not move to the cloud when the brain does. No NVIDIA GPU
   → no voice (the console still chats by text).
2. **Vision follows the brain.** Camera frames go to the brain as image
   blocks, so vision works locally (Qwen3.8 is natively multimodal) or with
   any cloud vision model.

---

## Mode 1 — Full local (Linux / DGX, most private, no recurring cost)

Everything on one NVIDIA box. The reference platform is the **DGX Spark
(GB10, aarch64)**; any Linux machine with a recent NVIDIA GPU and enough
memory works.

**Hardware guidance:** the ~27B NVFP4 brain needs roughly **60–80 GB during
load** on unified-memory boxes. A DGX Spark's 121 GB fits **one** brain plus
the voice models — never try to run two brains on it. The compose file pins
the model **revision** so an upstream re-upload can't silently change the
weights.

**Requirements:** Docker Engine + `docker compose`, the **NVIDIA Container
Toolkit**, and the CUDA base image the GPU services build from.

```bash
git clone https://github.com/MrQbit/0rb.git && cd 0rb
bash scripts/install.sh        # idempotent; prompts for your owner email
```

`install.sh` starts a local image registry on :5001, generates `.env`,
builds the api/ui/whatsapp images, reuses or retags existing GPU images, and
migrates pre-rebrand model caches. Manage the stack with
`./scripts/orb2-stack.sh {up|down|restart|status|logs|heal}`.

## Mode 2 — Cloud brain, app local (no NVIDIA GPU)

Run the **app tier** locally and point the brain at a cloud
OpenAI-compatible endpoint. Good for a MacBook or Windows laptop (Docker
Desktop), a Raspberry Pi, or any low-power box.

On GPU-less installs: **voice is off** (`ORB2_VOICE_ENABLED=0`) and the brain
**must** be cloud. Text chat, widgets, smart home, channels, web search,
Blender and memory (minus semantic recall unless you point `ORB2_EMBED_URL`
at a hosted embedder) all work.

Set in `.env`:

```ini
# Brain → a cloud OpenAI-compatible endpoint (OpenRouter / OpenAI /
# Anthropic's OpenAI-compatible endpoint — or your own GPU box):
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_MODEL=<provider-model-id>
OPENAI_API_KEY=<key>

# No GPU → no local voice:
ORB2_VOICE_ENABLED=0
```

Then bring up only the app tier (omit the GPU services):

```bash
docker compose -f docker-compose.spark.yml up -d \
  orb2-api ui redis searxng whatsapp blender av-webrtc homeassistant watchdog
```

You can also flip an existing install to a cloud brain at any time from
**Settings → System** (or by asking the agent) — the change applies live.

**Where the cloud brain comes from** (any OpenAI-compatible URL):
- **Your own Spark over Tailscale** — run Mode 1 on your Spark, expose
  `:8888` on the tailnet, and point a second machine's `OPENAI_BASE_URL` at it.
- **A GPU box / VPS** you rent, running the same vLLM image.
- **A hosted provider** — OpenRouter, OpenAI, or Anthropic's
  OpenAI-compatible endpoint. Pick a multimodal model if you want vision.

There is also a middle path on GPU boxes: the **smart router**
(`ORB2_ROUTER_ENABLED=1` + `ORB2_OPENROUTER_KEY`) keeps voice turns on the
local brain and routes hard turns to a cloud model (default `openai/gpt-4o`).

## Mode 3 — Windows with an NVIDIA GPU (full local via WSL2)

A Windows PC with an NVIDIA RTX card can run **everything** like Mode 1:

1. Install **WSL2** + a recent NVIDIA driver (the Windows driver exposes the
   GPU to WSL2 — no separate Linux driver).
2. Install **Docker Desktop** with the **WSL2 backend** and enable GPU support.
3. Inside WSL2, follow Mode 1.

---

## Per-OS notes

### Linux (recommended host)
Native Docker + NVIDIA Container Toolkit. This is the reference platform
(`scripts/install.sh`; `scripts/orb2.service` for a boot unit).

### macOS (Apple Silicon)
No NVIDIA GPU → **Mode 2** (Docker Desktop for Mac + cloud brain, voice off).
Run 0rb at login via a LaunchAgent that runs `docker compose up -d`.

### Windows
- **With an NVIDIA GPU →** Mode 3 (WSL2, full local).
- **Without →** Mode 2 (Docker Desktop + cloud brain, voice off).
Start at login via Task Scheduler (or Docker Desktop "start on login").

### Raspberry Pi
**Mode 2** (64-bit OS + Docker). The app tier is light; give it a Pi 4/5 with
4 GB+ and keep the brain in the cloud. Voice off.

---

## Persistence (run it as a service)

All services use `restart: unless-stopped`, and the watchdog restarts
anything that goes unhealthy, so the stack is reboot-proof on its own. For a
belt-and-suspenders boot unit on Linux:

```bash
sudo cp scripts/orb2.service /etc/systemd/system/
sudo systemctl enable --now orb2
```

On macOS use a LaunchAgent; on Windows a Task Scheduler task at logon — each
just runs `docker compose -f docker-compose.spark.yml up -d`.

---

## Remote access

Remote mic/camera need a secure context — browsers only expose them over real
HTTPS. Two paths:

### Tailscale (available today)

```bash
bash scripts/setup-tailscale.sh            # tailnet-only
bash scripts/setup-tailscale.sh --funnel   # also public
```

Set `ORB2_PUBLIC_URL` to the resulting `https://<machine>.<tailnet>.ts.net`.

### Device hostnames — `<id>.device.orb2.app` (being finalized)

The zero-config path: on boot the box claims a per-device hostname from the
hosted device-DNS relay, points it at its LAN IP, and obtains its **own**
Let's Encrypt certificate via DNS-01 — no inbound ports, works behind NAT,
renews automatically. The relay only ever handles DNS records and ACME
challenges; the TLS key never leaves your box. Gated on `ORB2_DEVICE_DOMAIN` +
`ORB2_BROKER_URL` + `ORB2_ENROLL_SECRET` (staging certs by default;
`ORB2_ACME_PRODUCTION=1` for real ones).

Either way, everything stays behind 0rb's email/Telegram-OTP auth.
