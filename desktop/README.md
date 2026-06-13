# rak00n desktop shell

A thin **Electron** host that turns the rak00n orb console into a desktop-layer
app — it loads on login and *feels like* the agent owns the machine, with a few
privileged "system widgets" (terminal, docker, files, native browser) the
browser sandbox can't provide.

## Design (why this stays cheap to maintain)

This is **one UI, not two.** The shell loads your existing web console
(`RAK00N_URL`) unchanged — every visual/data widget (charts, 3D, music, a Vercel
widget, …) works here automatically with **zero changes to this app**. Only a
small, fixed set of OS powers lives here, exposed as `window.rak00n.*`:

| Capability | API |
|---|---|
| Terminal (real shell) | `window.rak00n.terminal.spawn()` |
| Docker | `window.rak00n.docker(['ps'])` |
| Files (under `$HOME`) | `window.rak00n.files.read/list/write` |
| Open in real browser | `window.rak00n.openExternal(url)` |

Privileged widgets **feature-detect** these (`if (window.rak00n?.terminal) …`);
in a plain browser `window.rak00n` is undefined so they hide/degrade. **Adding a
new data/visual widget never touches this app** — it's pure web in the console.

## Run (dev)

```bash
cd desktop
npm install
RAK00N_URL=http://localhost:9080 npm run dev    # windowed
npm start                                       # desktop-layer (fullscreen)
```

## Configuration (env)

- `RAK00N_URL` — your rak00n console (local `http://localhost:9080`, or your own
  box over Tailscale `https://<machine>.<tailnet>.ts.net`). Default local.
- `RAK00N_SHELL_MODE` — `desktop` (frameless fullscreen, default) or `window`.
- `RAK00N_FS_ROOTS` — `:`-separated roots the file bridge may touch (default `$HOME`).

Auto-launch at login is enabled on first run (via `auto-launch`, with Electron's
login-item as a fallback). Control/quit from the tray icon.

## Build installers

```bash
npm run dist:win      # NSIS .exe   (run on Windows)
npm run dist:mac      # .dmg        (run on macOS)
npm run dist:linux    # AppImage + .deb
```

Native optional deps (`node-pty`, `dockerode`) are rebuilt for Electron via
`electron-builder install-app-deps`. They're optional — the terminal falls back
to a piped child process and docker shells out to the `docker` CLI, so the app
runs even if a native module can't build on a given platform.

## Security

A desktop shell that can run shells and Docker is powerful. rak00n's model is
**single-user + security via isolation + confirm-or-undo**: the file bridge is
root-restricted, outward/destructive agent actions stay behind the agent's
confirmation, and you should only point `RAK00N_URL` at your own authenticated
rak00n. `contextIsolation` is on and the preload is the only bridge.

> Add app icons under `assets/` (`icon.ico`, `icon.icns`, `icon.png`, `tray.png`)
> before building installers.
