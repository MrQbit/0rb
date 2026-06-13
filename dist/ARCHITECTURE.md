# orb2 architecture

orb2 runs as a single **Docker Compose** stack on one machine (designed for a
DGX Spark / GB10, but the app layer runs on any Docker host). No Kubernetes, no
mandatory cloud. Every service is on one compose network, reaches the others by
name, and has a healthcheck + `restart: unless-stopped`. A watchdog restarts
anything that goes unhealthy, so the system self-heals and survives reboots.

## Services

```
                ┌──────────────────────── host (GB10) ─────────────────────────┐
 browser / iOS ─►│ ui (nginx :9080/:9443) ─► orb2-api :8080 ─► vllm :8888 (brain)│
 Telegram      ─►│      │                       │  │                             │
 WhatsApp       ►│      │ proxies /v1 + voice WS │  ├─► stt :8990   faster-whisper │
                 │      │                        │  ├─► tts :8991   Kokoro TTS      │
                 │      │                        │  ├─► embed :8994 semantic memory │
                 │      │                        │  ├─► blender :8996  3D → glTF    │
                 │      │                        │  ├─► searxng     web search       │
                 │      │                        │  └─► redis  sessions+config+vectors│
                 │  watchdog ── supervises everything above ───────────────────────│
                 └───────────────────────────────────────────────────────────────┘
```

- **vllm** — **Qwen3.6-35B-A3B-NVFP4** (MoE, multimodal) on the GPU, OpenAI-
  compatible, with MTP speculative decoding. The brain. Vision is native: camera
  frames are sent here as image blocks (no separate vision service).
- **stt** / **tts** — GPU voice (faster-whisper, Kokoro). The agent does
  endpointing + barge-in and is itself what answers.
- **embed** — GPU embeddings (bge) for semantic memory.
- **blender** — headless Blender; runs agent-authored `bpy` scripts and exports
  glTF into the shared workspace volume, rendered in a 3D model widget.
- **orb2-api** — the Bun agent: chat, tools, voice WS, channels, canvas/widgets,
  connectors, memory, auth, settings. The sandbox runs in-process (no pods).
- **ui** — nginx; serves the orb console and proxies `/v1`, `/a2a`, `/docs` and
  the voice WebSocket to `orb2-api`.
- **redis** — session transcripts + runtime settings + memory vectors/graph.
- **searxng** — private web-search backend for the WebSearch tool.
- **watchdog** — `scripts/orb2-watchdog.sh`; restarts unhealthy/exited
  services. (Pause it before stopping a service for maintenance — it will
  otherwise restart it.)

Only **vllm / tts / stt / embed** require an NVIDIA GPU. The rest are
platform-agnostic — see [DEPLOYMENT.md](DEPLOYMENT.md) for the local /
cloud-model / cross-platform modes.

## Request paths

- **Chat** — `POST /v1/chat/stream` (SSE). The agent runs a turn against vLLM
  with the full tool set; tool output streams back, including `widget` events.
- **Voice** — `wss://…/v1/voice/ws`: browser streams 16 kHz PCM → STT → the
  agent → Kokoro TTS streamed back, with barge-in. Gated by the session.
- **Widgets / Canvas** — the `Widget` tool emits typed specs (chart, results,
  video, music, table, stats, gallery, image, embed, **3D model**, html) over a
  per-session bus → the console renders free-floating cards. The `Canvas` tool
  writes full web apps to `.canvas/`, served at `/v1/workspace/<session>/…`, and
  `Publish` snapshots them to a public page (or Vercel).
- **Vision** — the latest camera frame is sent to vLLM as an image content block
  (`ORB2_VISION_BACKEND=llm`).
- **Connectors** — YouTube / Spotify / News / Vercel / Google Drive / OneDrive
  are OAuth/key connectors exposed as agent tools and Settings cards; tokens live
  in Redis.
- **Channels** — Telegram long-polls and WhatsApp (via the bridge) run the same
  agent turn.

## Brain pointing

The brain is configured purely via OpenAI-compatible env on `orb2-api`:
`OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_API_KEY`. Point it at the local
`vllm` service, at your own box over Tailscale, or at a hosted endpoint — no code
change. The model is served under both its real name and a `qwen3-coder-next`
alias so config stays stable across model swaps.

## Auth

Email or Telegram one-time-code, allowlisted. A verified code mints a signed
(HMAC, stateless) session token used as an HttpOnly cookie (browser) or a
`Bearer` (iOS/channels). The API routes, the console shell (server-side gate),
and the voice WS are all gated by it.

## Configuration

`docker-compose.spark.yml` + a gitignored `.env` (interpolated by compose) +
runtime overrides in Redis via the console **Settings** page. Control the stack
with `scripts/orb2-stack.sh {up|down|status|logs|heal}`.

## Self-evolution

The agent can edit its own source, build it, validate it in a throwaway sandbox
container, and promote it to the running `orb2-api` with automatic rollback —
gated by `ORB2_SELF_MODIFY_ENABLED` and the mounted repo + docker socket.

## Remote access

`scripts/setup-tailscale.sh` publishes the console over the tailnet with HTTPS
(required for remote voice), still behind the email/Telegram-OTP auth.
