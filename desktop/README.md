# orb2 desktop shell

A thin **Electron** host that turns the orb2 orb console into a desktop-layer
app — it loads on login and *feels like* the agent owns the machine, with a few
privileged "system widgets" (terminal, docker, files, native browser) the
browser sandbox can't provide.

## Design (why this stays cheap to maintain)

This is **one UI, not two.** The shell loads your existing web console
(`ORB2_URL`) unchanged — every visual/data widget (charts, 3D, music, a Vercel
widget, …) works here automatically with **zero changes to this app**. Only a
small, fixed set of OS powers lives here, exposed as `window.orb2.*`:

| Capability | API |
|---|---|
| Terminal (real shell) | `window.orb2.terminal.spawn()` |
| Docker | `window.orb2.docker(['ps'])` |
| Files (under `$HOME`) | `window.orb2.files.read/list/write` |
| Open in real browser | `window.orb2.openExternal(url)` |

Privileged widgets **feature-detect** these (`if (window.orb2?.terminal) …`);
in a plain browser `window.orb2` is undefined so they hide/degrade. **Adding a
new data/visual widget never touches this app** — it's pure web in the console.

## Run (dev)

```bash
cd desktop
npm install
ORB2_URL=http://localhost:9080 npm run dev    # windowed
npm start                                       # desktop-layer (fullscreen)
```

## Configuration (env)

- `ORB2_URL` — your orb2 console (local `http://localhost:9080`, or your own
  box over Tailscale `https://<machine>.<tailnet>.ts.net`). Default local.
- `ORB2_SHELL_MODE` — `desktop` (frameless fullscreen, default) or `window`.
- `ORB2_FS_ROOTS` — `:`-separated roots the file bridge may touch (default `$HOME`).

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

A desktop shell that can run shells and Docker is powerful. orb2's model is
**single-user + security via isolation + confirm-or-undo**: the file bridge is
root-restricted, outward/destructive agent actions stay behind the agent's
confirmation, and you should only point `ORB2_URL` at your own authenticated
orb2. `contextIsolation` is on and the preload is the only bridge.

> Add app icons under `assets/` (`icon.ico`, `icon.icns`, `icon.png`, `tray.png`)
> before building installers.
