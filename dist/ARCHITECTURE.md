# 0rb architecture

0rb runs as a single **Docker Compose** stack on one machine (designed for a
DGX Spark / GB10, but the app tier runs on any Docker host). No Kubernetes, no
mandatory cloud. Every service is on one compose network, reaches the others by
name, and has a healthcheck + `restart: unless-stopped`. A watchdog restarts
anything that goes unhealthy, so the system self-heals and survives reboots
(add `scripts/orb2.service` as a systemd unit for belt and suspenders).

## Services

```
                ┌──────────────────────── host (GB10) ──────────────────────────┐
 browser / iOS ─►│ ui (nginx :9080/:9443) ─► orb2-api :8080 ─► vllm :8888 (brain) │
 Telegram      ─►│      │                        │  ├─► stt :8990    faster-whisper│
 WhatsApp      ─►│      │ proxies /v1 + voice WS │  ├─► tts :8991    Kokoro TTS    │
                 │      │                        │  │     └─► orpheus-llama :8081  │
                 │      │                        │  ├─► embed :8994  semantic memory│
                 │      │                        │  ├─► blender :8996  3D → glTF   │
                 │      │                        │  ├─► searxng      web search     │
                 │      │                        │  ├─► homeassistant :8123 (host)  │
                 │      │                        │  └─► redis  sessions+config+vecs │
                 │  watchdog ── supervises everything above ────────────────────────│
                 └──────────────────────────────────────────────────────────────────┘
```

- **vllm** — the brain: **Qwen3.8-27B** (dense, Apache 2.0, natively
  multimodal) as the NVFP4 quant `unsloth/Qwen3.8-27B-NVFP4` on the official
  `vllm/vllm-openai` image (aarch64), OpenAI-compatible on :8888. Runs with
  the `qwen3_coder` tool-call parser and `qwen3` reasoning parser, and serves
  the model under two aliases — `qwen3.8` and the legacy `qwen3-coder-next` —
  so config survives model swaps. The **revision is pinned** in the compose
  file: upstream HF re-uploads have silently broken unpinned models before.
  It replaced Meta Muse Glimmer 30B after a measured tool-use bake-off
  (28/30 vs 16/30 correct calls, 3.7s vs 19.4s median latency).
- **stt / tts / orpheus-llama** — GPU voice. `stt` runs faster-whisper; `tts`
  runs Kokoro by default, or decodes Orpheus tokens (from the `orpheus-llama`
  llama.cpp service) for expressive speech. The agent does endpointing +
  barge-in and is itself what answers. Voice is **independent of the brain
  choice** — a cloud brain still uses these local GPU services.
- **embed** — GPU embeddings (bge) for semantic memory recall.
- **blender** — headless Blender; runs agent-authored `bpy` scripts and
  exports glTF into the shared workspace volume, rendered in a 3D widget.
- **homeassistant** — Home Assistant on **host networking** (it needs
  mDNS/SSDP to discover devices), config in `~/.orb2/homeassistant`, its own
  console on :8123. The agent reaches it through the host gateway.
- **orb2-api** — the Bun agent: chat, tools, voice WS, channels, widgets,
  connectors, memory, auth, settings, self-evolution. Sandbox runs in-process.
- **ui** — nginx; serves the orb console and proxies `/v1`, `/a2a`, `/docs`
  and the voice WebSocket to `orb2-api`.
- **redis** — Redis Stack: session transcripts, runtime settings, memory
  vectors + relationship graph.
- **searxng** — private web-search backend for the WebSearch tool (an
  optional Brave key adds a second engine).
- **av-webrtc** — WebRTC ingest for a remote device's camera/mic.
- **whatsapp** — WhatsApp Web bridge (Baileys); relays allowed numbers.
- **watchdog** — `scripts/orb2-watchdog.sh`; restarts unhealthy/exited
  services (pause it before stopping a service for maintenance).

Only **vllm / stt / tts / orpheus-llama / embed** need an NVIDIA GPU. The rest
are platform-agnostic — see [DEPLOYMENT.md](DEPLOYMENT.md) for the local /
cloud-brain / cross-platform modes.

## Request paths

- **Chat** — `POST /v1/chat/stream` (SSE). The agent runs a turn against the
  brain with the full tool set; tool output streams back, including `widget`
  events.
- **Voice** — `wss://…/v1/voice/ws`: browser streams 16 kHz PCM → STT → the
  agent → Kokoro TTS streamed back, with barge-in. Gated by the session.
- **Vision** — the latest camera frame is sent to the multimodal brain as an
  image content block (`ORB2_VISION_BACKEND=llm`). Works with the local brain
  or any cloud vision model.
- **Widgets** — the `Widget` tool emits typed specs over a per-session bus →
  the console renders free-floating cards. Map specs are validated server-side
  (invented coordinates are rejected and place strings geocoded — the
  "Null Island" guard). The `CreateWidget` tool can install a **new widget
  type at runtime**; the console hot-loads it
  ([docs/widget-plugins.md](docs/widget-plugins.md)).
- **Canvas / Publish** — the Canvas tool writes full web apps to `.canvas/`,
  served at `/v1/workspace/<session>/…`; `Publish` snapshots them to a public
  page (or Vercel).
- **Smart home** — the `Home` tool (list/status/control/media/lights/climate/
  vacuum) calls Home Assistant's REST/WebSocket APIs and emits per-function
  widgets. `HomeAdmin` goes further: the area/entity **registry** (rename,
  assign, hide) and the **config-flow API** (list discovered devices, drive
  pairing, start new integrations, diagnose unavailable devices).
- **Connectors** — YouTube / Spotify / News / Vercel / Google / Microsoft are
  OAuth/key connectors exposed as tools and Settings cards; tokens in Redis.
- **Channels** — Telegram long-polls and WhatsApp (via the bridge) run the
  same agent turn as the console.

## Brain pointing

The brain is configured purely via OpenAI-compatible env on `orb2-api`:
`OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_API_KEY`. Point it at the local
`vllm` service, at your own box over Tailscale, or at a hosted endpoint
(OpenRouter, OpenAI, Anthropic's OpenAI-compatible endpoint) — from Settings →
System or by asking the agent — and the switch applies **live**, no restart.
The dual serving aliases keep config stable across local model swaps.

On top of that sits an optional **intent-based router**
(`ORB2_ROUTER_ENABLED=1` + `ORB2_OPENROUTER_KEY`): voice turns stay on the
local brain for latency, hard turns route to a cloud model (default
`openai/gpt-4o`).

## Auth

Email or Telegram one-time codes, allowlisted; the first allowlisted email
becomes the owner. Email codes deliver via your own SMTP if configured, else a
hosted relay, else the API log (see [SECURITY.md](SECURITY.md)). A verified
code mints a signed **stateless HMAC** session token (`ORB2_AUTH_SECRET`) used
as an HttpOnly cookie (browser) or a Bearer token (iOS/channels). The API
routes, the console shell (server-side gate), and the voice WS are all gated
by it.

## Configuration

`docker-compose.spark.yml` + a gitignored `.env` (interpolated by compose) +
runtime overrides in Redis via the console **Settings** panel — which the
agent itself can open, read (secrets only as set/unset), and change through a
whitelist of keys. Control the stack with
`scripts/orb2-stack.sh {up|down|restart|status|logs|heal}`.

## Self-evolution

The agent can edit its own source, build it, validate it in a throwaway
sandbox container, and promote it to the running `orb2-api` with automatic
rollback — gated by `ORB2_SELF_MODIFY_ENABLED` and requiring the mounted repo
+ docker socket.

## Remote access

`scripts/setup-tailscale.sh` publishes the console over the tailnet with real
HTTPS (required for remote voice/camera). A hosted device-DNS relay that gives
each box a `<id>.device.orb2.app` hostname with a Let's Encrypt cert (DNS-01,
works behind NAT) is being finalized as the zero-config path — see
[DEPLOYMENT.md](DEPLOYMENT.md). Both stay behind the OTP auth.
