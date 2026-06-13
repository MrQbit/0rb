// orb2 desktop shell — Electron main process.
//
// Philosophy: this is a THIN HOST. It loads the existing orb2 web console
// (served by the `ui` service) unchanged, and adds a small, FIXED set of
// privileged OS capabilities over IPC. New visual/data widgets live entirely in
// the web UI and need zero changes here — only genuinely new OS powers (rare)
// touch this file. See ../CONTRIBUTING.md and the bridge in preload.js.

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, screen } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { startLocal, stopLocal } = require('./local-backend')

// ── config ─────────────────────────────────────────────────────────────────
// First-run setup (setup.html) writes this; afterwards we load the orb from it.
// Env still wins for power users / dev.
let cfg = {}
function configPath() { return path.join(app.getPath('userData'), 'config.json') }
function loadConfig() { try { cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8')) } catch { cfg = {} } }
function saveConfig(next) { cfg = { ...cfg, ...next }; try { fs.mkdirSync(path.dirname(configPath()), { recursive: true }) } catch {} fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2)) }
// liveUrl is set once the local backend (or chosen server) is reachable.
let liveUrl = null
function orb2Url() { return process.env.ORB2_URL || liveUrl || cfg.url || 'http://localhost:9080' }
function isConfigured() { return !!(process.env.ORB2_URL || cfg.url || cfg.mode) }

// Bring up whatever this config points at, then resolve the URL to load.
//   server → just use the URL.  local/cloud → spin up the local backend.
async function bringUp(onStatus) {
  if (process.env.ORB2_URL) { liveUrl = process.env.ORB2_URL; return { ok: true } }
  if (cfg.mode === 'server') { liveUrl = cfg.url; return { ok: true } }
  const r = await startLocal(cfg, onStatus)        // local or cloud
  if (r.ok) liveUrl = r.url
  return r
}

// Display modes — user-switchable (tray → Display), default 'blended':
//   blended  — the orb IS the desktop: frameless, transparent, fills the
//              screen behind your windows. Widgets float on it; you blend the
//              orb with your normal apps. Feels like the OS belongs to the orb.
//   web      — the orb site as a focused FULLSCREEN app (opaque kiosk). You're
//              "in" the orb. (Open the website locally, full screen.)
//   window   — a normal resizable window (dev / casual).
function shellMode() {
  let m = process.env.ORB2_SHELL_MODE || cfg.shellMode || 'blended'
  if (m === 'desktop') m = 'blended'          // legacy alias
  return ['blended', 'web', 'window'].includes(m) ? m : 'blended'
}
const ALLOW_ROOTS = (process.env.ORB2_FS_ROOTS || os.homedir()).split(path.delimiter)

let mainWindow = null
let setupWindow = null
let tray = null

function createWindow() {
  const mode = shellMode()
  const blended = mode === 'blended'
  const web = mode === 'web'

  mainWindow = new BrowserWindow({
    show: false,
    frame: mode === 'window',                 // chrome only in window mode
    fullscreen: web,                          // true fullscreen for the web kiosk
    // Opaque + robust by default. A true see-through overlay (the OS desktop
    // visible behind the orb) also needs the orb PAGE to go transparent — opt
    // in with cfg.blendedTransparent once that page mode exists.
    transparent: blended && !!cfg.blendedTransparent,
    backgroundColor: blended && cfg.blendedTransparent ? '#00000000' : '#0a0d0a',
    autoHideMenuBar: true,
    title: 'orb2',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,   // bridge is the ONLY surface
      nodeIntegration: false,
      sandbox: false,           // preload needs node to talk to the host
      spellcheck: false,
    },
  })

  if (blended) {
    // Be the desktop: fill the screen behind normal windows (transparent +
    // fullscreen don't mix on all platforms, so we size to the display bounds
    // instead of using fullscreen:true), on every workspace, no taskbar entry.
    try { const b = screen.getPrimaryDisplay().bounds; mainWindow.setBounds(b) } catch {}
    mainWindow.setAlwaysOnTop(false)
    try { mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) } catch {}
    if (process.platform === 'linux') { try { mainWindow.setType?.('desktop') } catch {} }
    if (process.platform === 'darwin') { try { mainWindow.setWindowButtonVisibility?.(false) } catch {} }
    mainWindow.setSkipTaskbar(true)
  } else if (web) {
    mainWindow.setSkipTaskbar(false)
  }

  mainWindow.loadURL(orb2Url())
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  mainWindow.on('closed', () => { mainWindow = null })
}

// Switch display mode at runtime: persist + recreate the window.
function setShellMode(m) {
  saveConfig({ shellMode: m })
  if (mainWindow) { const w = mainWindow; mainWindow = null; w.destroy() }
  createWindow()
  if (tray) createTray()   // refresh the radio checkmarks
}

function createTray() {
  if (!tray) {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'))
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
    tray.setToolTip('orb2')
  }
  const m = shellMode()
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show orb', click: () => mainWindow ? mainWindow.show() : createWindow() },
    { label: 'Reload', click: () => mainWindow?.reload() },
    { type: 'separator' },
    { label: 'Display', submenu: [
      { label: 'Blended desktop', type: 'radio', checked: m === 'blended', click: () => setShellMode('blended') },
      { label: 'Fullscreen (web)', type: 'radio', checked: m === 'web', click: () => setShellMode('web') },
      { label: 'Window', type: 'radio', checked: m === 'window', click: () => setShellMode('window') },
    ] },
    { label: `Connected to ${orb2Url()}`, enabled: false },
    { type: 'separator' },
    { label: 'Quit orb2', click: () => { app.exit(0) } },
  ]))
}

// ── first-run setup wizard ───────────────────────────────────────────────────
function createSetupWindow(booting) {
  setupWindow = new BrowserWindow({
    width: 620, height: 720, resizable: false, autoHideMenuBar: true,
    backgroundColor: '#06080a', title: 'orb2 — setup',
    webPreferences: { preload: path.join(__dirname, 'setup-preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  setupWindow.loadFile(path.join(__dirname, 'setup.html'), booting ? { search: '?booting=1' } : undefined)
  setupWindow.on('closed', () => { setupWindow = null })
}

const pushStatus = msg => { try { setupWindow?.webContents.send('setup:status', msg) } catch {} }

ipcMain.handle('setup:get', () => ({ ...cfg, platform: process.platform, arch: process.arch }))
ipcMain.handle('setup:save', async (_e, next) => {
  saveConfig(next)
  pushStatus('Setting things up…')
  const r = await bringUp(pushStatus)
  if (!r.ok) return r                       // wizard shows the error (needsInstall → opens download)
  const w = setupWindow
  createWindow(); createTray()
  if (w) w.close()
  return { ok: true }
})

// Bring the orb up for an already-configured install (local backend may take
// a while on first run — show progress in a boot splash).
async function boot() {
  loadConfig()
  if (!isConfigured()) { createSetupWindow(); return }
  if (cfg.mode === 'server' || (process.env.ORB2_URL && !cfg.mode)) {
    await bringUp(() => {}); createWindow(); createTray(); return
  }
  createSetupWindow(true)                    // boot splash
  const r = await bringUp(pushStatus)
  if (r.ok) { const w = setupWindow; createWindow(); createTray(); if (w) w.close() }
  else pushStatus('⚠ ' + (r.message || 'Could not start orb2.'))
}

// ── auto-launch at login (cross-platform) ────────────────────────────────────
async function ensureAutoLaunch() {
  try {
    const AutoLaunch = require('auto-launch')
    const launcher = new AutoLaunch({ name: 'orb2', isHidden: false })
    if (!(await launcher.isEnabled())) await launcher.enable()
  } catch {
    // Fallback to Electron's own login-item registration (win/mac).
    try { app.setLoginItemSettings({ openAtLogin: true }) } catch {}
  }
}

// ── the privileged capability bridge (IPC) ───────────────────────────────────
// A small, FIXED set of OS powers the browser sandbox can't provide. Privileged
// widgets in the web UI feature-detect `window.orb2.*`; everything else is
// pure web and never reaches here.

function underAllowedRoot(p) {
  const real = path.resolve(p)
  return ALLOW_ROOTS.some(root => real === path.resolve(root) || real.startsWith(path.resolve(root) + path.sep))
}

// Terminal (node-pty if present, else a piped child_process fallback).
const terms = new Map()
ipcMain.handle('term:spawn', (e, { shell: sh, cwd, cols, rows } = {}) => {
  const id = Math.random().toString(36).slice(2)
  const shellPath = sh || (process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash')
  try {
    const pty = require('node-pty')
    const p = pty.spawn(shellPath, [], { name: 'xterm-color', cols: cols || 80, rows: rows || 24, cwd: cwd || os.homedir(), env: process.env })
    p.onData(d => mainWindow?.webContents.send('term:data', { id, data: d }))
    p.onExit(() => mainWindow?.webContents.send('term:exit', { id }))
    terms.set(id, { kind: 'pty', p })
  } catch {
    const { spawn } = require('node:child_process')
    const c = spawn(shellPath, [], { cwd: cwd || os.homedir(), env: process.env })
    c.stdout.on('data', d => mainWindow?.webContents.send('term:data', { id, data: d.toString() }))
    c.stderr.on('data', d => mainWindow?.webContents.send('term:data', { id, data: d.toString() }))
    c.on('exit', () => mainWindow?.webContents.send('term:exit', { id }))
    terms.set(id, { kind: 'cp', p: c })
  }
  return { id }
})
ipcMain.handle('term:write', (e, { id, data }) => { const t = terms.get(id); if (!t) return; t.kind === 'pty' ? t.p.write(data) : t.p.stdin.write(data) })
ipcMain.handle('term:resize', (e, { id, cols, rows }) => { const t = terms.get(id); if (t?.kind === 'pty') t.p.resize(cols, rows) })
ipcMain.handle('term:kill', (e, { id }) => { const t = terms.get(id); if (!t) return; t.kind === 'pty' ? t.p.kill() : t.p.kill(); terms.delete(id) })

// Docker (CLI shell-out — works whether or not dockerode is installed).
ipcMain.handle('docker:run', (e, args) => new Promise(resolve => {
  const { execFile } = require('node:child_process')
  execFile('docker', Array.isArray(args) ? args : ['ps'], { timeout: 30000 }, (err, stdout, stderr) =>
    resolve({ ok: !err, stdout: stdout || '', stderr: stderr || (err ? String(err) : '') }))
}))

// Filesystem (restricted to ORB2_FS_ROOTS, default $HOME).
ipcMain.handle('fs:read', (e, p) => { if (!underAllowedRoot(p)) throw new Error('path not allowed'); return fs.promises.readFile(p, 'utf8') })
ipcMain.handle('fs:list', (e, p) => { if (!underAllowedRoot(p)) throw new Error('path not allowed'); return fs.promises.readdir(p, { withFileTypes: true }).then(es => es.map(d => ({ name: d.name, dir: d.isDirectory() }))) })
ipcMain.handle('fs:write', (e, { path: p, data }) => { if (!underAllowedRoot(p)) throw new Error('path not allowed'); return fs.promises.writeFile(p, data) })

ipcMain.handle('app:openExternal', (e, url) => shell.openExternal(url))
ipcMain.handle('system:info', () => ({ platform: process.platform, arch: process.arch, home: os.homedir(), url: orb2Url(), owner: cfg.ownerEmail, brain: cfg.brain }))

// ── lifecycle ────────────────────────────────────────────────────────────────
const single = app.requestSingleInstanceLock()
if (!single) app.exit(0)
app.on('second-instance', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus() } })

app.whenReady().then(() => {
  boot()                         // first run → setup; else bring the backend up
  ensureAutoLaunch()
  app.on('activate', () => { if (!mainWindow && !setupWindow) boot() })
})
app.on('before-quit', () => { try { stopLocal() } catch {} })
app.on('window-all-closed', () => { /* stay alive in tray; quit from the tray menu */ })
