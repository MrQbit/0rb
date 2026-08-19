# 0rb

Your personal **Jarvis** — a single-user AI agent that runs on **your own
hardware**. Local brain, local voice, native vision, durable memory, a smart
home it can organize and control, and no cloud dependency required. Talk to it
by voice, message it from Telegram or WhatsApp, watch it build charts / 3D /
web apps on screen, reach it securely from anywhere — and it can even rewrite
and ship its own code.

Designed for an **NVIDIA DGX Spark (GB10)**, but the brain is pointed by
standard OpenAI-compatible env, so hardware-constrained machines can run the
app locally with a **cloud brain** instead (see
**[DEPLOYMENT.md](DEPLOYMENT.md)** for Linux / macOS / Windows / Raspberry Pi).

---

## What it is

- **The orb** — the whole console is a living green orb that *is* the agent.
  Tap it to chat, tap while it's talking to interrupt, drag it anywhere; the
  page behind it is the agent's canvas. Audio-reactive, minimal chrome.
- **Local brain** — **Qwen3.8-27B** (dense, Apache 2.0, **natively
  multimodal**) served as the NVFP4 quant `unsloth/Qwen3.8-27B-NVFP4` on vLLM.
  Chosen over Meta Muse Glimmer 30B by a measured tool-use bake-off: **28/30 vs
  16/30** calls correct, **3.7s vs 19.4s** median call latency.
- **Cloud brain, fully supported** — set `OPENAI_BASE_URL` / `OPENAI_MODEL` /
  `OPENAI_API_KEY` (Settings → System, or just ask the agent) to point at
  OpenRouter, OpenAI, or Anthropic's OpenAI-compatible endpoint. The switch
  applies live — no restart.
- **Smart router** — optionally route by intent: voice turns stay on the local
  brain for latency, hard turns go to a cloud model
  (`ORB2_ROUTER_ENABLED=1` + `ORB2_OPENROUTER_KEY`, default `openai/gpt-4o`).
- **Voice** — continuous speech with barge-in and streaming TTS (it starts
  speaking the first sentence while still thinking): GPU STT (faster-whisper)
  → the agent → GPU neural TTS (Kokoro), with Orpheus (llama.cpp) as an
  optional expressive engine. Voice runs on the local GPU services regardless
  of which brain you use.
- **Vision** — a camera toggle streams frames straight to the **multimodal
  brain** as image blocks — no separate vision model. Works with the local
  Qwen3.8 brain or any cloud vision model.
- **Widgets & Canvas** — a typed widget framework: charts, tables, media
  players, maps, thermostats, 3D models and full web apps render as
  free-floating cards — and the agent can **mint brand-new widget types at
  runtime** (see [docs/widget-plugins.md](docs/widget-plugins.md)).
- **Smart home** — Home Assistant ships in the stack. The agent controls
  lights / media / climate / locks / vacuums, **organizes** the home (areas,
  renames, hiding), and **sets up devices itself** — driving HA's pairing
  config-flows (e.g. a webOS TV) and starting new integrations (e.g. a
  Roomba).
- **Memory** — durable file memory + **semantic recall** (GPU embeddings +
  vector search) + a relationship graph, consolidated by a periodic "dream."
- **Channels** — **Telegram** and **WhatsApp** (link your own account by QR).
- **Auth** — email **or Telegram** one-time codes, allowlisted, no passwords.
  Email codes deliver via your own SMTP, a hosted relay fallback, or the API
  log — see [SECURITY.md](SECURITY.md).
- **Self-evolution** — the agent can edit its own source, build it, validate
  it in a throwaway sandbox, and promote it to the running instance with
  automatic rollback. Gated by `ORB2_SELF_MODIFY_ENABLED`.
- **Self-healing** — restart policies + a watchdog + an optional systemd unit;
  the stack comes back on its own after a reboot.
- **iOS app** — native SwiftUI client ([`iOS/`](iOS/)).

## The stack

One Docker Compose stack ([`docker-compose.spark.yml`](docker-compose.spark.yml)),
all services on one network, each with a healthcheck + restart policy:

| Service | Role | GPU |
|---|---|---|
| `vllm` | Qwen3.8-27B NVFP4 brain (OpenAI-compatible, :8888) — text + vision | ● |
| `stt` | faster-whisper STT (:8990) | ● |
| `tts` | Kokoro neural TTS (:8991) | ● |
| `orpheus-llama` | optional expressive-TTS token generator (llama.cpp, :8081) | ● |
| `embed` | bge embeddings for semantic memory (:8994) | ● |
| `blender` | headless Blender — agent-authored 3D → glTF (:8996) | |
| `av-webrtc` | WebRTC A/V ingest (:8993) | |
| `redis` | sessions + runtime config + vectors/graph (Redis Stack) | |
| `orb2-api` | the agent (Bun) — the brain of the system | |
| `whatsapp` | WhatsApp Web bridge (Baileys, :8995) | |
| `searxng` | private web-search backend for the WebSearch tool | |
| `homeassistant` | Home Assistant (host networking for discovery, console :8123) | |
| `ui` | nginx console — front door (HTTP :9080, HTTPS :9443) | |
| `watchdog` | restarts any service that goes unhealthy | |

Only the **GPU** rows need an NVIDIA GPU; the rest run anywhere Docker does.
Model revisions are **pinned** in the compose file — upstream Hugging Face
re-uploads have silently broken unpinned models before. There is no
Kubernetes — a single-user box doesn't need it. See
[ARCHITECTURE.md](ARCHITECTURE.md).

## Agent tools

36+ tools, gated on their config so the agent only sees what's actually set
up. Highlights: file tools (Read/Write/Edit/LS), Widget, WebSearch (SearXNG +
optional Brave), NewsSearch, YouTube, Music (Spotify), Weather (defaults to
your home location, auto-resolved from Home Assistant), Geocode/Directions
(map widget with server-side coordinate validation), Docker/DockerOps,
Blender (3D → glTF), Publish, Vision, RecallMemory, Vault, Concierge,
Shopping (persistent list + buy options + checkout handoff — it never claims
an order was placed), Wallet (payment-method **metadata only** — label, brand,
last4), Home + HomeAdmin (control, organize, and pair smart-home devices),
Settings (the agent reads and changes its own whitelisted settings live),
CreateWidget (mint new widget types at runtime), and the self-evolution suite.

## Install

Full per-platform detail (and the cloud-brain mode for machines without an
NVIDIA GPU) is in **[DEPLOYMENT.md](DEPLOYMENT.md)**.

On a fresh DGX Spark (aarch64 + NVIDIA), with Docker + the NVIDIA Container
Toolkit installed:

```bash
git clone https://github.com/MrQbit/0rb.git && cd 0rb
bash scripts/install.sh        # registry, .env, build, up — prompts for your owner email
```

`install.sh` is idempotent: it starts a local image registry on :5001,
generates `.env` from [`.env.example`](.env.example), builds the
api / ui / whatsapp images, reuses or retags existing GPU images, migrates
pre-rebrand model caches, and brings the stack up.

## Run it

```bash
./scripts/orb2-stack.sh up        # start the whole stack
./scripts/orb2-stack.sh status    # ps + health
./scripts/orb2-stack.sh logs orb2-api
./scripts/orb2-stack.sh heal      # tail the watchdog
```

Open **http://localhost:9080** (or **https://localhost:9443** for camera/mic),
sign in with your allowlisted email — the first allowlisted email becomes the
owner — and the orb greets you.

## Configuration

Runtime config lives in a gitignored `.env` (see [`.env.example`](.env.example))
and the console's **Settings** panel — which floats like a widget and which the
agent itself can open, read, and change (whitelisted keys only, secrets shown
only as set/unset).

- **Brain** — `OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_API_KEY` (local vLLM
  or any cloud OpenAI-compatible endpoint; applies live).
- **Router** — `ORB2_ROUTER_ENABLED`, `ORB2_OPENROUTER_KEY`,
  `ORB2_ROUTER_STRONG_MODEL`.
- **Auth** — allowlist via `ORB2_AUTH_ALLOWED_EMAILS` or Settings → Access;
  sessions signed with `ORB2_AUTH_SECRET`; own SMTP via `ORB2_SMTP_*`
  (optional — the hosted relay covers fresh installs).
- **Smart home** — `ORB2_HA_URL` + `ORB2_HA_TOKEN` (long-lived token from the
  HA profile → Security page) enable the Home tools and widgets.
- **Telegram** — `ORB2_TELEGRAM_BOT_TOKEN` + `ORB2_TELEGRAM_OWNER_ID`.
- **WhatsApp** — `ORB2_OWNER_PHONE`; link from Settings → Channels (scan the QR).
- **Voice** — `ORB2_VOICE_ENABLED`, `ORB2_STT_URL`, `ORB2_TTS_URL`,
  `ORB2_TTS_VOICE`, `ORB2_TTS_ENGINE` (kokoro | orpheus).
- **Connected apps** — YouTube / Spotify / News / Vercel + Google & Microsoft
  cloud storage, from Settings → Apps (or the matching `ORB2_*` env).
- **Self-evolution** — `ORB2_SELF_MODIFY_ENABLED`, `ORB2_SELF_SRC_HOST`.

## Remote access

Remote mic/camera need a secure context (real HTTPS). Two paths:

```bash
bash scripts/setup-tailscale.sh            # tailnet-only
bash scripts/setup-tailscale.sh --funnel   # also public
```

Then set `ORB2_PUBLIC_URL` to your `https://<machine>.<tailnet>.ts.net` URL.

A zero-config alternative is being finalized: per-device hostnames
(`<id>.device.orb2.app`) with real Let's Encrypt certificates via a hosted
device-DNS relay — see [DEPLOYMENT.md](DEPLOYMENT.md). Either way, everything
stays behind 0rb's OTP auth.

## Repository layout

```
docker-compose.spark.yml   the stack (model revisions pinned here)
.env.example               configuration template
scripts/                   install.sh, orb2-stack.sh, watchdog, tailscale, self-evolve
services/                  tts stt embed blender av-webrtc whatsapp searxng (Dockerfiles)
src/api/                   the agent API (auth, voice, channels, memory, vision, home, widgets, connectors)
web/public/                the orb console (index.html, orb.css, orb-shell.js)
docs/                      widget-plugin contract and other docs
iOS/                       native app source
```

## Security

0rb is single-user and allowlisted; sessions are stateless HMAC tokens; the
API, console shell, and voice socket are all gated server-side. The wallet
stores payment-method metadata only (never card numbers), widget URLs are
validated before they touch an iframe, and self-evolution is sandbox-validated
with rollback behind a flag. Details in [SECURITY.md](SECURITY.md).

## License

**[PolyForm Noncommercial 1.0.0](LICENSE)** — free for any noncommercial use,
modification and redistribution, with attribution preserved. Commercial use or
commercial redistribution requires written permission from the author.
