/**
 * Widget registry routes for Settings → Apps.
 *   GET  /v1/widgets/registry  (session) → WidgetStatus[]
 *   POST /v1/widgets/toggle    (session) → { id, enabled } → persists on/off
 * On/off is stored as a comma-separated ORB2_WIDGETS_DISABLED setting (KV +
 * process.env) so it survives restarts, mirroring the other settings.
 */
import { readFileSync } from 'node:fs'
import type { Store } from '../store/store.js'
import { authEnabled, verifySession, parseCookies, SESSION_COOKIE } from '../auth/session.js'
import { getWidgetRegistry, toggleWidgetDisabled, WIDGET_CATALOG } from './registry.js'
import { listPlugins, pluginFile, installPlugin, removePlugin } from './plugins.js'

const SETTINGS_KV_PREFIX = 'setting:'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
function authed(req: Request): boolean {
  if (!authEnabled()) return true
  const a = req.headers.get('authorization') ?? ''
  let token = /^Bearer\s+/i.test(a) ? a.replace(/^Bearer\s+/i, '').trim() : ''
  if (!token) token = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE] ?? ''
  return !!(token && verifySession(token))
}

/**
 * The plugin sandbox frame (v0.2 §14). Served as a REAL document so it gets
 * its OWN CSP (srcdoc iframes inherit the console's CSP, which blocks inline
 * scripts). The frame + boot script + plugin render.js are fetched by an
 * opaque-origin sandboxed iframe, which never sends cookies — so these three
 * GETs are deliberately unauthenticated. They expose only renderer code,
 * never data: the spec arrives by postMessage from the console, and the
 * frame's CSP (default-src 'none') means the plugin cannot call out.
 */
const FRAME_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:"
const FRAME_HTML = `<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="dark">
<style>
:root{color-scheme:dark;--ink:#e9f1e2;--ink-dim:#93a08f;--mono:ui-monospace,"JetBrains Mono","SF Mono",Menlo,monospace}
body{margin:0;padding:4px;font-family:system-ui;color:var(--ink);background:transparent;font-size:13px}
</style>
<script type="module" src="/v1/widgets/frame-boot.js"></script>`
const FRAME_BOOT = `const id = new URLSearchParams(location.search).get('plugin') || ''
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
let mod = null
async function draw(spec){
  try{
    mod = mod || await import('/v1/widgets/plugins/' + encodeURIComponent(id) + '/render.js')
    const fn = mod.render || mod.default
    if (typeof fn !== 'function') throw new Error('plugin exports no render()')
    document.body.replaceChildren()
    await fn(document.body, spec, { esc })
  }catch(e){ document.body.textContent = 'plugin error: ' + e.message }
}
addEventListener('message', e => { if (e.data && e.data.type === 'orb-spec') draw(e.data.spec) })
parent.postMessage({ type: 'orb-ready', plugin: id }, '*')`

export async function tryWidgetRegistryRoute(req: Request, method: string, pathname: string, store: Store): Promise<Response | null> {
  if (!pathname.startsWith('/v1/widgets/')) return null

  if (method === 'GET' && pathname === '/v1/widgets/frame') {
    return new Response(FRAME_HTML, { status: 200, headers: {
      'content-type': 'text/html; charset=utf-8', 'content-security-policy': FRAME_CSP, 'cache-control': 'no-cache',
    } })
  }
  if (method === 'GET' && pathname === '/v1/widgets/frame-boot.js') {
    return new Response(FRAME_BOOT, { status: 200, headers: { 'content-type': 'text/javascript', 'cache-control': 'no-cache' } })
  }
  const pubRender = pathname.match(/^\/v1\/widgets\/plugins\/([A-Za-z0-9._-]+)\/render\.js$/)
  if (method === 'GET' && pubRender) {
    const f = pluginFile(pubRender[1]!, 'render.js')
    if (!f) return json(404, { error: 'not found' })
    return new Response(readFileSync(f.path), { status: 200, headers: { 'content-type': f.contentType, 'cache-control': 'no-cache' } })
  }

  if (!authed(req)) return json(401, { error: 'authentication required' })

  if (method === 'GET' && pathname === '/v1/widgets/registry') {
    return json(200, { widgets: await getWidgetRegistry(store) })
  }
  // Custom widget plugins (runtime, no recompile).
  if (method === 'GET' && pathname === '/v1/widgets/plugins') {
    return json(200, { plugins: listPlugins() })
  }
  if (method === 'POST' && pathname === '/v1/widgets/plugins') {
    const b = (await req.json().catch(() => ({}))) as any
    try { return json(200, { installed: installPlugin(b) }) }
    catch (e) { return json(400, { error: (e as Error).message }) }
  }
  const pd = pathname.match(/^\/v1\/widgets\/plugins\/([A-Za-z0-9._-]+)$/)
  if (method === 'DELETE' && pd) {
    return removePlugin(pd[1]!) ? json(200, { removed: pd[1] }) : json(404, { error: 'not found' })
  }
  const pf = pathname.match(/^\/v1\/widgets\/plugins\/([A-Za-z0-9._-]+)\/(.+)$/)
  if (method === 'GET' && pf) {
    const f = pluginFile(pf[1]!, pf[2]!)
    if (!f) return json(404, { error: 'not found' })
    return new Response(readFileSync(f.path), {
      status: 200,
      headers: { 'content-type': f.contentType, 'cache-control': 'no-cache' },
    })
  }
  if (method === 'POST' && pathname === '/v1/widgets/toggle') {
    const b = (await req.json().catch(() => ({}))) as any
    const id = String(b.id || '').trim()
    if (!id || !WIDGET_CATALOG.some(w => w.id === id)) return json(400, { error: 'unknown widget id' })
    const enabled = b.enabled !== false
    const csv = toggleWidgetDisabled(id, enabled)
    process.env.ORB2_WIDGETS_DISABLED = csv
    await store.putKv(`${SETTINGS_KV_PREFIX}ORB2_WIDGETS_DISABLED`, csv, 0).catch(() => {})
    return json(200, { id, enabled, disabled: csv })
  }
  return null
}
