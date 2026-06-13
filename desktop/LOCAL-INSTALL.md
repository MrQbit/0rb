# 0rb — local consumer install (Windows / macOS)

Goal: a normal user downloads one installer, runs it, answers a couple of
questions, and has a **fully functional orb running entirely on their machine**
— no Docker, no CUDA, no terminal.

## Architecture (consumer, no Docker)

```
┌──────────────────────── Electron app (the installer + shell) ───────────────┐
│                                                                              │
│  First run → setup wizard (owner email + Local / Cloud / Connect)            │
│                                                                              │
│  Local mode orchestrates, on this machine:                                   │
│                                                                              │
│   ┌── Ollama ──────────────┐   ┌── orb2-api (compiled Bun binary) ──────┐  │
│   │ localhost:11434/v1     │◄──┤ OPENAI_BASE_URL=…:11434/v1               │  │
│   │ model: qwen3-vl:8b     │   │ MemoryStore (no REDIS_URL)               │  │
│   │ (vision + tools)       │   │ settings/owner/keys passed as env        │  │
│   └────────────────────────┘   │ serves the orb UI + /v1                  │  │
│                                 └──────────────────────────────────────────┘  │
│   Voice (optional): whisper.cpp (STT) + Piper (TTS) — cross-platform binaries │
│                                                                              │
│  Electron then loads the orb UI from the local api and stays in the tray.    │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Why these choices
- **Ollama** is the model runtime: one-line cross-platform install, an
  OpenAI-compatible API at `:11434/v1`, manages model downloads, runs on Metal
  (Mac) and CUDA/CPU (Win). Default model **Qwen-VL 8B** (vision + tool-calling
  = full orb functionality with no code changes). See `defaults.js`.
- **MemoryStore** (no Redis): the api uses an in-memory store when `REDIS_URL`
  is unset (`src/api/store/store.ts`). Durable config (owner email, app keys,
  brain endpoint) lives in the Electron `config.json` and is passed to the api
  as **env on every launch**, so it survives restarts even though the store is
  in-memory. Login sessions reset on restart (acceptable; user re-signs-in).
- **Compiled api**: ship `orb2-api` as a standalone binary
  (`bun build --compile`), so the user needs neither Bun nor Node.
- **Voice**: whisper.cpp + Piper are cross-platform and need no GPU — the
  consumer voice path. (Orpheus/SenseVoice are the Spark/CUDA path and are not
  shipped here.)

## Packaged app keys
Owner-level, **safe-to-share** keys are baked into the build so widgets work
out of the box (they return only public data — no per-user leak):
`desktop/keys.json` (gitignored placeholder → real values injected at build by
the maintainer). Covers: YouTube Data API key, Spotify app id+secret, and the
Google/Microsoft OAuth client IDs for the device-code account flow. Per-user
data (their Google/MS account, Vercel token) is still connected by each user in
Settings → Apps.

## Build pipeline (maintainer)
1. `bun run build:api` → `dist/api.mjs`
2. `bun build --compile dist/api.mjs --outfile desktop/bin/orb2-api[-mac|.exe]`
3. Copy the web UI (`web/public`) into the app resources (served by the api).
4. Drop real keys into `desktop/keys.json`.
5. `cd desktop && npm run dist:mac` / `dist:win` → signed installer.

## Display modes (user-switchable — tray → Display)
The user chooses how the orb takes the screen; default **blended**:
- **Blended desktop** — frameless, fills the screen, sits *behind* your normal
  windows at the desktop level (no taskbar, all workspaces). The orb is your
  backdrop; widgets float on it; your app windows float over it — it feels like
  the machine belongs to the orb. (Opaque + robust. A true *see-through*
  overlay, where the real OS desktop shows behind the orb, also needs a
  transparent page mode in the orb UI — opt in via `cfg.blendedTransparent`;
  TODO.)
- **Fullscreen (web)** — the orb site as a focused fullscreen kiosk app. You're
  "in" the orb. (This is the "open the website locally in full screen" option.)
- **Window** — a normal resizable window (dev / casual).
Switchable at runtime from the tray; persisted in `config.json`.

## Status
- [x] Setup wizard (owner email + Local/Cloud/Connect)
- [x] Display modes: blended desktop / fullscreen web / window (tray switcher)
- [ ] `local-backend.js` orchestrator (Ollama ensure/pull + api spawn) — WIP
- [ ] Compiled api binary + bundling
- [ ] keys.json injection + first-run application
- [ ] Cross-platform voice (whisper.cpp + Piper) packaging
