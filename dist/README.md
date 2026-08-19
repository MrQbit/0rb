# 0rb

**A private AI for your home — brain, voice, memory, and smart home, all running
on hardware you own.**

0rb is a self-hosted agent that lives with your household instead of in a
datacenter. Talk to it by voice, message it from Telegram or WhatsApp, watch it
render charts, maps, 3D scenes and entire web apps onto its canvas. It runs
your smart home end to end — pairing new devices, organizing rooms, watching
for trouble — knows each member of the family by voice, and can even rewrite,
validate, and ship its own code.

<p align="center">
  <a href="https://orb2.app/assets/demo.mp4">
    <img src="docs/media/demo-poster.jpg" alt="0rb demo — a morning with Orb" width="720">
  </a>
  <br>
  <a href="https://orb2.app/assets/demo.mp4"><strong>▶ Watch the demo</strong></a>
  — a morning with 0rb: briefing, a kitchen timer, shopping staples, setting
  the house to away, and a map. Captured live against a running instance;
  every response is the model's own.
</p>

Designed for an **NVIDIA DGX Spark (GB10)**, but the brain is addressed through
standard OpenAI-compatible env — hardware-constrained machines run the same app
with a **cloud brain** instead. Per-platform installs (Linux / macOS / Windows /
Raspberry Pi) are in **[DEPLOYMENT.md](DEPLOYMENT.md)**.

---

## Why it's different

- **The console is not a chat window.** The whole UI is a living, audio-reactive
  green orb that *is* the agent. Tap it to talk, tap while it's speaking to
  interrupt, drag it anywhere — the page behind it is the agent's canvas, and
  everything it shows you renders as free-floating widget cards.
- **Local by default, cloud by choice.** The stock brain, voice, vision, and
  memory all run on your GPU. Pointing `OPENAI_BASE_URL` at any
  OpenAI-compatible endpoint swaps the brain live — no restart — and voice
  stays local either way.
- **A household member, not a single-user tool.** Owner and member roles,
  per-person preferences and reminders, a family board, chore rotas, shared
  calendar — and it recognizes *who is speaking* by voice.
- **It maintains itself.** A watchdog heals the stack, and (behind a flag) the
  agent can edit its own source, validate the build in a sandbox, and promote
  it with automatic rollback.

## Capabilities

### Brain

- **Local:** **Qwen3.8-27B** (dense, Apache 2.0, natively multimodal) served as
  the NVFP4 quant `unsloth/Qwen3.8-27B-NVFP4` on vLLM. Chosen over Meta Muse
  Glimmer 30B in a measured tool-use bake-off: **28/30 vs 16/30** correct
  calls, **3.7 s vs 19.4 s** median latency.
- **Cloud:** set `OPENAI_BASE_URL` / `OPENAI_MODEL` / `OPENAI_API_KEY`
  (Settings → System, or just ask the agent) for OpenRouter, OpenAI, or the
  **Anthropic API, spoken natively** — point the endpoint at
  `https://api.anthropic.com` with an `sk-ant-…` key and a Claude model.
  Applies live.
- **Smart router (optional):** voice turns stay on the local brain for latency,
  hard turns go to a stronger cloud model (`ORB2_ROUTER_ENABLED=1` +
  `ORB2_OPENROUTER_KEY`).

### Voice & vision

- Continuous speech with **barge-in** and **streaming TTS** — it starts
  speaking the first sentence while still thinking. GPU STT (faster-whisper) →
  agent → GPU neural TTS (Kokoro), with Orpheus (llama.cpp) as an optional
  expressive engine.
- **Speaker identification:** ECAPA voice embeddings match each utterance to a
  household member, and enrollment is self-supervised — it learns your voice
  from normal use.
- **Vision:** a camera toggle streams frames straight to the multimodal brain
  as image blocks — no separate vision model.

### Canvas & widgets

- A typed widget framework: charts, tables, media players, maps, thermostats,
  document viewers, 3D models, and full web apps render as floating cards.
- The agent can **mint brand-new widget types at runtime** — it writes the
  renderer, registers it, and uses it in the same conversation
  ([docs/widget-plugins.md](docs/widget-plugins.md)).

### Smart home

Home Assistant ships in the stack and 0rb treats it as a backend:

- **Control** — lights, media, climate, locks, covers, vacuums, plugs, scenes,
  cameras (live MJPEG), 3D printers — each with a purpose-built widget.
- **Organize** — the agent assigns areas, renames entities, hides duplicates,
  and filters diagnostic noise so only real devices surface.
- **Set up devices itself** — it drives HA's pairing config-flows (a webOS TV,
  a Roomba, a Bambu Lab printer) and proactively nudges you when something new
  appears on the network.
- **Watch the house** — house modes (home / away / night), arrival routines,
  instant safety alerts (smoke, water, locks), and device-health checks, all
  mode-aware so you're not spammed.
- **Beyond HA: the LAN bridge** — AirPlay speakers/TVs and network (IPP)
  printers are discovered and used **directly**: speak or stream audio on any
  AirPlay device, print without drivers — zero setup, even for devices Home
  Assistant doesn't know. The bridge also advertises the console over mDNS so
  the native apps find the server automatically.

### Household

- **Roles:** the first owner can add owners and members; critical settings
  (model, connections, access) are owner-only.
- **Family board, notes and reminders** — including presence-triggered
  delivery ("tell Ana when she gets home") and announcements to specific
  rooms' speakers.
- **Shared calendar** with recurring events, per-person **preferences** the
  agent honors automatically, **chore rotas**, care **routines**, and a
  **morning briefing**.
- **Shopping** — a persistent list with recurring staples, buy options, and a
  checkout handoff (it never claims to have placed an order itself).

### Memory

Durable file memory + **semantic recall** (GPU embeddings + vector search) + a
relationship graph, consolidated by a periodic "dream."

### Channels & apps

**Telegram** and **WhatsApp** (link your own account by QR), a native SwiftUI
**iOS app** ([`iOS/`](iOS/)), and connected apps — YouTube, Spotify, news,
weather, cloud storage. Adding a connector is as easy as pasting a key into
chat: the agent recognizes the credential's shape and files it under the right
setting.

### Self-evolution & self-healing

The agent can edit its own source, build it, validate it in a throwaway
sandbox, and promote it to the running instance with automatic rollback
(gated by `ORB2_SELF_MODIFY_ENABLED`). Restart policies, a watchdog, and an
optional systemd unit bring the stack back on its own after a reboot.

## Quickstart

On a fresh DGX Spark (aarch64 + NVIDIA) with Docker and the NVIDIA Container
Toolkit:

```bash
git clone https://github.com/MrQbit/0rb.git && cd 0rb
bash scripts/install.sh        # registry, .env, build, up — prompts for your owner email
```

`install.sh` is idempotent: it starts a local image registry, generates `.env`
from [`.env.example`](.env.example), builds the api / ui / whatsapp images,
reuses existing GPU images, and brings the stack up. Then:

```bash
./scripts/orb2-stack.sh up        # start the whole stack
./scripts/orb2-stack.sh status    # ps + health
./scripts/orb2-stack.sh logs orb2-api
./scripts/orb2-stack.sh heal      # tail the watchdog
```

Open **http://localhost:9080** (or **https://localhost:9443** for camera/mic),
sign in with your allowlisted email — the first allowlisted email becomes the
owner — and the orb greets you. No NVIDIA GPU? `scripts/preflight.sh` tells
you what your machine can run, and **[DEPLOYMENT.md](DEPLOYMENT.md)** covers
the cloud-brain install for Mac, Windows, and Raspberry Pi.

## The stack

One Docker Compose stack ([`docker-compose.spark.yml`](docker-compose.spark.yml)),
all services on one network, each with a healthcheck and restart policy:

| Service | Role | GPU |
|---|---|---|
| `vllm` | Qwen3.8-27B NVFP4 brain (OpenAI-compatible, :8888) — text + vision | ● |
| `stt` | faster-whisper STT + speaker embeddings (:8990) | ● |
| `tts` | Kokoro neural TTS (:8991) | ● |
| `orpheus-llama` | optional expressive-TTS token generator (llama.cpp, :8081) | ● |
| `embed` | bge embeddings for semantic memory (:8994) | ● |
| `blender` | headless Blender — agent-authored 3D → glTF (:8996) | |
| `av-webrtc` | WebRTC A/V ingest (:8993) | |
| `redis` | sessions + runtime config + vectors/graph (Redis Stack) | |
| `orb2-api` | the agent (Bun) — the heart of the system | |
| `whatsapp` | WhatsApp Web bridge (Baileys, :8995) | |
| `searxng` | private web-search backend for the WebSearch tool | |
| `homeassistant` | Home Assistant (host networking for discovery, console :8123) | |
| `ui` | nginx console — front door (HTTP :9080, HTTPS :9443) | |
| `watchdog` | restarts any service that goes unhealthy | |

Only the **GPU** rows need an NVIDIA GPU; the rest run anywhere Docker does.
Model revisions are **pinned** in the compose file — upstream Hugging Face
re-uploads have silently broken unpinned models before. There is no
Kubernetes — a home box doesn't need it. See
[ARCHITECTURE.md](ARCHITECTURE.md).

## Agent tools

36+ tools, each gated on its config so the agent only sees what's actually set
up: file tools (Read/Write/Edit/LS), Widget, WebSearch (SearXNG + optional
Brave), NewsSearch, YouTube, Music (Spotify), Weather (defaults to your home
location, auto-resolved from Home Assistant), Geocode/Directions (map widget
with server-side coordinate validation), Docker/DockerOps, Blender (3D →
glTF), Publish, Vision, RecallMemory, Vault, Concierge, Timer, Shopping,
Wallet (payment-method **metadata only** — label, brand, last4), Home +
HomeAdmin (control, organize, and pair smart-home devices), Family (notes,
reminders, calendar, chores, announcements, briefings), Settings (the agent
reads and changes its own whitelisted settings live), CreateWidget, and the
self-evolution suite.

## Configuration

Runtime config lives in a gitignored `.env` (see [`.env.example`](.env.example))
and the console's **Settings** panel — which floats like a widget and which the
agent itself can open, read, and change (whitelisted keys only; secrets shown
only as set/unset).

| Area | Keys |
|---|---|
| Brain | `OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_API_KEY` — local vLLM or any cloud endpoint, applies live |
| Router | `ORB2_ROUTER_ENABLED`, `ORB2_OPENROUTER_KEY`, `ORB2_ROUTER_STRONG_MODEL` |
| Auth | allowlist via `ORB2_AUTH_ALLOWED_EMAILS` or Settings → Access; sessions signed with `ORB2_AUTH_SECRET`; own SMTP via `ORB2_SMTP_*` (optional — a hosted relay covers fresh installs) |
| Smart home | `ORB2_HA_URL` + `ORB2_HA_TOKEN` (long-lived token from the HA profile → Security page) |
| Telegram | `ORB2_TELEGRAM_BOT_TOKEN` + `ORB2_TELEGRAM_OWNER_ID` |
| WhatsApp | `ORB2_OWNER_PHONE`; link from Settings → Channels (scan the QR) |
| Voice | `ORB2_VOICE_ENABLED`, `ORB2_STT_URL`, `ORB2_TTS_URL`, `ORB2_TTS_VOICE`, `ORB2_TTS_ENGINE` (kokoro \| orpheus) |
| Connected apps | YouTube / Spotify / News / Vercel + Google & Microsoft cloud storage — Settings → Apps, or just paste a key into chat |
| Self-evolution | `ORB2_SELF_MODIFY_ENABLED`, `ORB2_SELF_SRC_HOST` |

Sign-in is passwordless: allowlisted email **or Telegram** one-time codes.
Email codes deliver via your own SMTP, a hosted relay fallback, or the API
log — see [SECURITY.md](SECURITY.md).

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
scripts/                   install.sh, orb2-stack.sh, preflight, watchdog, tailscale, self-evolve
services/                  tts stt embed blender av-webrtc whatsapp searxng (Dockerfiles)
src/api/                   the agent API (auth, voice, family, channels, memory, vision, home, widgets, connectors)
web/public/                the orb console (index.html, orb.css, orb-shell.js)
docs/                      widget-plugin contract and other docs
iOS/                       native app source
```

## Security & privacy

Access is allowlisted and passwordless; sessions are stateless HMAC tokens;
the API, console shell, and voice socket are all gated server-side, with
critical settings restricted to owners. The wallet stores payment-method
metadata only (never card numbers), widget URLs are validated before they
touch an iframe, and self-evolution is sandbox-validated with rollback behind
a flag. Details in [SECURITY.md](SECURITY.md).

## License

**[PolyForm Noncommercial 1.0.0](LICENSE)** — free for any noncommercial use,
modification and redistribution, with attribution preserved. Commercial use or
commercial redistribution requires written permission from the author.
