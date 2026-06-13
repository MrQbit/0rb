/**
 * Push registration endpoints for the 0rb apps. Owner-session protected.
 *
 *   POST   /v1/push/register    { token }  → start receiving proactive nudges
 *   POST   /v1/push/unregister  { token }  → stop
 *   POST   /v1/push/test                   → send a test notification
 */
import type { Store } from '../store/store.js'
import { verifySession, parseCookies, SESSION_COOKIE } from '../auth/session.js'
import { registerToken, unregisterToken, sendPush, pushEnabled } from './fcm.js'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
async function readJson(req: Request): Promise<any> { try { return await req.json() } catch { return {} } }

export async function tryHandlePushRoute(method: string, pathname: string, req: Request, store: Store): Promise<Response | null> {
  if (!pathname.startsWith('/v1/push')) return null

  // Owner session required (the app holds one after login).
  const cookies = parseCookies(req.headers.get('cookie'))
  if (!verifySession(cookies[SESSION_COOKIE])) {
    return jsonResponse(401, { error: 'Sign in first', code: 'UNAUTHENTICATED' })
  }

  if (method === 'POST' && pathname === '/v1/push/register') {
    const token = String((await readJson(req))?.token || '').trim()
    if (!token) return jsonResponse(400, { error: 'token required' })
    await registerToken(store, token)
    return jsonResponse(200, { ok: true, push_configured: pushEnabled() })
  }

  if (method === 'POST' && pathname === '/v1/push/unregister') {
    const token = String((await readJson(req))?.token || '').trim()
    if (token) await unregisterToken(store, token)
    return jsonResponse(200, { ok: true })
  }

  if (method === 'POST' && pathname === '/v1/push/test') {
    await sendPush(store, '0rb', 'Test notification — your home can reach you. 🏠')
    return jsonResponse(200, { ok: true, push_configured: pushEnabled() })
  }

  return null
}
