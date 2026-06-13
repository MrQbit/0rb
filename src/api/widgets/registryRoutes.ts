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
import { listPlugins, pluginFile } from './plugins.js'

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

export async function tryWidgetRegistryRoute(req: Request, method: string, pathname: string, store: Store): Promise<Response | null> {
  if (!pathname.startsWith('/v1/widgets/')) return null
  if (!authed(req)) return json(401, { error: 'authentication required' })

  if (method === 'GET' && pathname === '/v1/widgets/registry') {
    return json(200, { widgets: await getWidgetRegistry(store) })
  }
  // Custom widget plugins (runtime, no recompile).
  if (method === 'GET' && pathname === '/v1/widgets/plugins') {
    return json(200, { plugins: listPlugins() })
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
