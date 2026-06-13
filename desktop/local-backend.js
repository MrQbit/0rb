// 0rb local backend orchestrator (consumer install, no Docker).
//
// Brings up everything the orb needs ON THIS MACHINE and returns the local URL
// the Electron shell should load:
//   1. Ollama  — ensure installed + running, pull the default Qwen-VL model.
//   2. orb2-api — spawn the compiled Bun binary with MemoryStore, pointed at
//      Ollama, with the owner/keys/brain config passed as env.
// Durable config lives in the Electron config.json; we pass it as env each
// launch so the in-memory store doesn't need to persist it.

const { spawn, execFile } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { app } = require('electron')
const { DEFAULT_MODEL, FALLBACK_MODEL, OLLAMA_URL, API_PORT, OLLAMA_DOWNLOAD } = require('./defaults')

let apiProc = null
let ollamaProc = null

// ── small helpers ────────────────────────────────────────────────────────────
function httpGet(url, timeout = 2500) {
  return new Promise(resolve => {
    const req = http.get(url, res => { res.resume(); resolve(res.statusCode || 0) })
    req.on('error', () => resolve(0))
    req.setTimeout(timeout, () => { req.destroy(); resolve(0) })
  })
}
async function waitHealthy(url, ms = 60000, step = 1000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await httpGet(url) >= 200) return true; await new Promise(r => setTimeout(r, step)) }
  return false
}
function onPath(bin) {
  return new Promise(resolve => {
    const which = process.platform === 'win32' ? 'where' : 'which'
    execFile(which, [bin], err => resolve(!err))
  })
}

// ── Ollama ───────────────────────────────────────────────────────────────────
async function ollamaUp() { return (await httpGet(`${OLLAMA_URL}/api/tags`)) >= 200 }

async function ensureOllama(onStatus) {
  if (await ollamaUp()) return { ok: true }
  if (!(await onPath('ollama'))) {
    return { ok: false, needsInstall: true, url: OLLAMA_DOWNLOAD,
      message: 'Ollama isn’t installed. It runs the AI model on your machine.' }
  }
  onStatus?.('Starting the model runtime…')
  ollamaProc = spawn('ollama', ['serve'], { detached: false, stdio: 'ignore' })
  ollamaProc.on('error', () => {})
  const ok = await waitHealthy(`${OLLAMA_URL}/api/tags`, 20000)
  return ok ? { ok: true } : { ok: false, message: 'Could not start Ollama.' }
}

function hasModel(tag) {
  return new Promise(resolve => {
    http.get(`${OLLAMA_URL}/api/tags`, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => {
        try { const t = JSON.parse(b).models || []; resolve(t.some(m => (m.name || '').startsWith(tag.split(':')[0]))) }
        catch { resolve(false) }
      })
    }).on('error', () => resolve(false))
  })
}

// Pull a model with streamed progress (Ollama's /api/pull NDJSON).
function pullModel(tag, onStatus) {
  return new Promise(resolve => {
    const body = JSON.stringify({ name: tag, stream: true })
    const req = http.request(`${OLLAMA_URL}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      let buf = ''
      res.on('data', d => {
        buf += d.toString()
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
          if (!line) continue
          try {
            const ev = JSON.parse(line)
            if (ev.error) { resolve({ ok: false, error: ev.error }); return }
            if (ev.total && ev.completed) onStatus?.(`Downloading ${tag} — ${Math.round(ev.completed / ev.total * 100)}%`)
            else if (ev.status) onStatus?.(ev.status)
          } catch { /* ignore partial */ }
        }
      })
      res.on('end', () => resolve({ ok: true }))
    })
    req.on('error', e => resolve({ ok: false, error: e.message }))
    req.end(body)
  })
}

async function ensureModel(onStatus) {
  for (const tag of [DEFAULT_MODEL, FALLBACK_MODEL]) {
    if (await hasModel(tag)) return { ok: true, model: tag }
    onStatus?.(`Fetching the AI model (${tag})… first run only.`)
    const r = await pullModel(tag, onStatus)
    if (r.ok) return { ok: true, model: tag }
    onStatus?.(`Couldn’t get ${tag}${r.error ? ' (' + r.error + ')' : ''}, trying a fallback…`)
  }
  return { ok: false, message: 'Could not download a model. Check your connection.' }
}

// ── orb2-api ───────────────────────────────────────────────────────────────
function apiBinaryPath() {
  const name = process.platform === 'win32' ? 'orb2-api.exe' : 'orb2-api'
  // Packaged: extraResources/bin/<name>. Dev: ./bin/<name>.
  const base = app.isPackaged ? process.resourcesPath : __dirname
  return path.join(base, 'bin', name)
}

function loadPackagedKeys() {
  for (const f of ['keys.json', 'keys.example.json']) {
    try { const j = JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8')); delete j._comment; return j } catch {}
  }
  return {}
}

function startApi(cfg, model) {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    ORB2_STANDALONE: '1',
    ORB2_API_PORT: String(API_PORT),
    ORB2_API_HOST: '127.0.0.1',
    // No REDIS_URL → MemoryStore (single-user local).
    // Brain = local Ollama (OpenAI-compatible).
    OPENAI_BASE_URL: `${OLLAMA_URL}/v1`,
    OPENAI_MODEL: model,
    OPENAI_API_KEY: 'ollama',
    // Owner + auth so only the user gets in.
    ORB2_API_AUTH_REQUIRED: '1',
    ORB2_AUTH_ALLOWED_EMAILS: cfg.ownerEmail || '',
    // Workspace + memory under the user's app data.
    ORB2_API_WORKSPACE_ROOT: path.join(app.getPath('userData'), 'workspace'),
    ORB2_COWORK_MEMORY_PATH_OVERRIDE: path.join(app.getPath('userData'), 'memory'),
    // Baked owner-level app keys (safe to share; public-data only).
    ...loadPackagedKeys(),
  }
  // Cloud-brain override from the wizard, if the user chose cloud.
  if (cfg.brain?.endpoint) { env.OPENAI_BASE_URL = cfg.brain.endpoint; env.OPENAI_MODEL = cfg.brain.model || model; env.OPENAI_API_KEY = cfg.brain.key || 'cloud' }

  const bin = apiBinaryPath()
  if (!fs.existsSync(bin)) return { ok: false, message: `API binary missing at ${bin} (build step pending).` }
  apiProc = spawn(bin, [], { env, stdio: 'ignore' })
  apiProc.on('error', () => {})
  return { ok: true }
}

// ── orchestration ──────────────────────────────────────────────────────────
// Returns { ok, url } or { ok:false, needsInstall?, url?, message }.
async function startLocal(cfg, onStatus) {
  // Cloud mode skips Ollama entirely.
  if (cfg.mode !== 'cloud') {
    const oll = await ensureOllama(onStatus)
    if (!oll.ok) return oll
    const m = await ensureModel(onStatus)
    if (!m.ok) return m
    onStatus?.('Starting orb2…')
    var model = m.model
  }
  const api = startApi(cfg, typeof model !== 'undefined' ? model : (cfg.brain?.model || ''))
  if (!api.ok) return api
  const healthy = await waitHealthy(`http://127.0.0.1:${API_PORT}/healthz`, 45000)
  if (!healthy) return { ok: false, message: 'orb2 didn’t start in time.' }
  return { ok: true, url: `http://127.0.0.1:${API_PORT}` }
}

function stopLocal() {
  try { apiProc?.kill() } catch {}
  try { ollamaProc?.kill() } catch {}   // only if WE started it
  apiProc = ollamaProc = null
}

module.exports = { startLocal, stopLocal, ensureOllama, ensureModel }
