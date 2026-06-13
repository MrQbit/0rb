/**
 * Tailscale remote-access routes for the Access settings panel.
 *   GET  /v1/tailscale/status  (session) → TsStatus
 *   POST /v1/tailscale/up      (session) → { authKey, hostname? } → connect + serve
 *   POST /v1/tailscale/down    (session) → disconnect (serve reset + down)
 * Owner-gated like the other privileged routes; down/up only run on explicit
 * user action so a connected node is never torn down by accident.
 */
import { authEnabled, verifySession, parseCookies, SESSION_COOKIE } from '../auth/session.js'
import { tailscaleConfigured, tailscaleStatus, tailscaleUp, tailscaleDown } from './tailscale.js'

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

export async function tryTailscaleRoute(req: Request, method: string, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith('/v1/tailscale/')) return null
  if (!authed(req)) return json(401, { error: 'authentication required' })
  if (!tailscaleConfigured()) return json(400, { error: 'tailscale control not enabled' })

  if (method === 'GET' && pathname === '/v1/tailscale/status') {
    return json(200, await tailscaleStatus())
  }
  if (method === 'POST' && pathname === '/v1/tailscale/up') {
    const b = (await req.json().catch(() => ({}))) as any
    const r = await tailscaleUp(String(b.authKey || '').trim(), b.hostname ? String(b.hostname).trim() : undefined)
    return json(r.ok ? 200 : 400, r)
  }
  if (method === 'POST' && pathname === '/v1/tailscale/down') {
    const r = await tailscaleDown()
    return json(r.ok ? 200 : 400, r)
  }
  return null
}
