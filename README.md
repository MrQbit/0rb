# rak00n

Your personal **Jarvis** — a single-user AI agent that runs on **your own
hardware**. Local brain, local voice, native vision, durable memory, no cloud
dependency required. Talk to it by voice, message it from Telegram or WhatsApp,
watch it build charts/3D/web on screen, reach it securely from anywhere — and
it can even rewrite and ship its own code.

Designed for an **NVIDIA DGX Spark (GB10)** but it runs in three modes — fully
local on any NVIDIA box, or with the model in the cloud for hardware-constrained
machines (see **[DEPLOYMENT.md](DEPLOYMENT.md)** for Linux / Windows / macOS).

> Built on a fork of the RAK00N agent CLI; the app layer is platform-agnostic.

---

## What it is

- **The orb** — the whole console is a living green orb that *is* the agent.
  Tap it to chat, tap while it's talking to interrupt, drag it anywhere; the
  page behind it is the agent's canvas. Audio-reactive, minimal chrome.
- **Local brain** — **Qwen3.6-35B-A3B-NVFP4** (MoE, multimodal) on vLLM with MTP
  speculative decoding (~60 tok/s on a Spark). OpenAI-compatible — point it at a
  cloud endpoint instead if you have no GPU.
- **Voice** — continuous speech with barge-in and **streaming TTS** (it starts
  speaking the first sentence while still thinking): GPU STT (faster-whisper)
  → the agent → GPU neural TTS (Kokoro).
- **Vision** — a camera toggle streams frames straight to the **multimodal
  brain** — no separate vision model — so the agent sees what you show it.
- **Widgets & Canvas** — a typed widget framework: the agent renders charts,
  tables, media players, image galleries, **3D models (Blender)** and embedded
  web apps as free-floating cards, and can publish full pages.
- **Connected apps** — YouTube, Spotify, News, **Google Drive + OneDrive cloud
  storage**, Vercel publishing, and private web search (SearXNG) — all wired
  into both Settings and the agent's tools.
- **Memory** — durable file memory + **semantic recall** (GPU embeddings +
  vector search) + a **relationship graph**, consolidated by a periodic
  "dream." It remembers across turns and sessions.
- **Channels** — **Telegram** and **WhatsApp** (link your own account by QR).
- **Auth** — email **or Telegram** one-time-code, allowlisted. No passwords.
  Server-side gate; managed users from the console.
- **Self-evolution** — the agent can edit its own source, build it, validate it
  in a throwaway sandbox, and promote it to the running instance with automatic
  rollback. Gated by `RAK00N_SELF_MODIFY_ENABLED`.
- **Self-healing** — Docker Compose with restart policies + a watchdog; comes
  back on its own after a reboot.
- **iOS app** — native SwiftUI client ([`iOS/`](iOS/)).

## Architecture

One Docker Compose stack ([`docker-compose.spark.yml`](docker-compose.spark.yml)),
all services on one network, each with a healthcheck + restart policy:

| Service | Role | GPU |
|---|---|---|
| `vllm` | Qwen3.6 brain (OpenAI-compatible, :8888) — text + vision | ● |
| `tts` | Kokoro neural TTS (:8991) | ● |
| `stt` | faster-whisper STT (:8990) | ● |
| `embed` | bge embeddings for semantic memory (:8994) | ● |
| `blender` | headless Blender — agent-authored 3D → glTF (:8996) | |
| `av-webrtc` | WebRTC A/V ingest (:8993) | |
| `redis` | sessions + runtime config + vectors/graph (Redis Stack) | |
| `rak00n-api` | the agent (Bun) — rak00n is the brain | |
| `whatsapp` | WhatsApp Web bridge (Baileys, :8995) | |
| `searxng` | private web-search backend for the WebSearch tool | |
| `ui` | nginx console — front door (HTTP :9080, HTTPS :9443) | |
| `watchdog` | restarts any service that goes unhealthy | |

Only the four **GPU** services need an NVIDIA GPU; the rest run anywhere Docker
does. There is **no Kubernetes** — a single-user box doesn't need it. See
[ARCHITECTURE.md](ARCHITECTURE.md).

## Install

Full details for Linux, Windows and macOS (and the cloud-model mode for
machines without an NVIDIA GPU) are in **[DEPLOYMENT.md](DEPLOYMENT.md)**.

On a fresh DGX Spark (aarch64 + NVIDIA), with Docker + the NVIDIA Container
Toolkit installed:

```bash
git clone https://github.com/MrQbit/rak00n.git && cd rak00n
bash scripts/install.sh        # registry, .env, build, up
# then edit .env (allowed email, SMTP, Telegram/WhatsApp) and:
./scripts/rak00n-stack.sh restart
```

`install.sh` starts a local image registry, generates `.env` from
[`.env.example`](.env.example), builds the api/ui/whatsapp images, builds the
GPU service images if their CUDA base is present, and brings the stack up. The
CPU services run even before the GPU images exist.

## Run it

```bash
./scripts/rak00n-stack.sh up        # start the whole stack
./scripts/rak00n-stack.sh status    # ps + health
./scripts/rak00n-stack.sh logs rak00n-api
./scripts/rak00n-stack.sh heal      # tail the watchdog
```

Open **http://localhost:9080** (or **https://localhost:9443** for camera/mic),
sign in with your allowlisted email — a code is emailed or sent via Telegram —
and the orb greets you.

## Configuration

Runtime config lives in a gitignored `.env` (see [`.env.example`](.env.example))
and the console's **Settings** panel (the gear on the orb page).

- **Brain** — `OPENAI_BASE_URL`, `OPENAI_MODEL` (point local or at a cloud
  endpoint). See [DEPLOYMENT.md](DEPLOYMENT.md).
- **Auth** — email/Telegram OTP. Allowlist via `RAK00N_AUTH_ALLOWED_EMAILS` or
  Settings → Allowed users. Email codes need `RAK00N_SMTP_*`.
- **Telegram** — `RAK00N_TELEGRAM_BOT_TOKEN` + `RAK00N_TELEGRAM_OWNER_ID`.
- **WhatsApp** — `RAK00N_OWNER_PHONE`; link from Settings → Channels (scan the QR).
- **Voice** — `RAK00N_VOICE_ENABLED`, `RAK00N_STT_URL`, `RAK00N_TTS_URL`, `RAK00N_TTS_VOICE`.
- **Connected apps** — YouTube/Spotify/News/Vercel + Google/Microsoft cloud
  storage are configured from Settings → Apps (or the matching `RAK00N_*` env).
- **Self-evolution** — `RAK00N_SELF_MODIFY_ENABLED`, `RAK00N_SELF_SRC_HOST`.

## Remote access

Publish the console over your tailnet with real HTTPS (needed for remote voice):

```bash
bash scripts/setup-tailscale.sh            # tailnet-only
bash scripts/setup-tailscale.sh --funnel   # also public
```

Then set `RAK00N_PUBLIC_URL` in `.env` to your `https://<machine>.<tailnet>.ts.net`
URL. Everything stays behind rak00n's email/Telegram-OTP auth.

## Repository layout

```
docker-compose.spark.yml   the stack
.env.example               configuration template
scripts/                   install.sh, rak00n-stack.sh, watchdog, tailscale, self-evolve
services/                  tts stt embed blender av-webrtc whatsapp searxng (Dockerfiles)
src/api/                   the agent API (auth, voice, channels, memory, vision, canvas, connectors)
src/tools/CanvasTool/      rak00n's visual surface
web/public/                the orb console (index.html, orb.css, orb-shell.js)
iOS/                       native app source
```

## Security

rak00n is single-user and allowlisted; the API + voice socket are gated by the
session, and the console shell is gated server-side. Self-evolution is
sandbox-validated with rollback and gated by a flag. See
[SECURITY.md](SECURITY.md).

## License

**[PolyForm Noncommercial 1.0.0](LICENSE)** — free for any noncommercial use,
modification and redistribution, with attribution preserved. Commercial use or
commercial redistribution requires written permission from the author.
