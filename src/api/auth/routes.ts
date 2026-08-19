/**
 * Username/password auth endpoints (public — must work before the
 * "identity required" gate):
 *
 *   POST /v1/auth/login    { username, password } → sets session cookie,
 *                          returns { token } (for the iOS app / channels)
 *   POST /v1/auth/logout   clears the session cookie
 *   GET  /v1/auth/me       { authenticated, username? }
 *
 * Changing the password (POST /v1/auth/password) requires an existing
 * session and is handled after the gate in server.ts.
 */
import type { Store } from '../store/store.js'
import type { CallerIdentity } from './context.js'
import {
  authEnabled,
  signSession,
  verifySession,
  sessionCookie,
  clearSessionCookie,
  parseCookies,
  SESSION_COOKIE,
} from './session.js'
import { requestOtp, verifyOtp, getUsers, addUser, removeUser, isOwner } from './otp.js'

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** Verified session username from cookie or bearer, or null. */
function sessionUser(req: Request): string | null {
  const auth = req.headers.get('authorization') ?? ''
  let token = /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : ''
  if (!token) token = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE] ?? ''
  return token ? (verifySession(token)?.u ?? null) : null
}

/**
 * Handle the public auth routes. Returns a Response if it owned the
 * request, else null so the main router continues.
 */
export async function handleAuthRoutes(
  req: Request,
  method: string,
  pathname: string,
  store: Store,
): Promise<Response | null> {
  // Email + OTP: request a code, then verify it to get a session.
  if (method === 'POST' && pathname === '/v1/auth/request-otp') {
    if (!authEnabled()) return json(200, { ok: true, authRequired: false })
    let body: { email?: string }
    try { body = (await req.json()) as any } catch { return json(400, { error: 'invalid JSON' }) }
    const email = (body.email ?? '').trim()
    const via = (body as any).via === 'telegram' ? 'telegram' : 'email'
    if (!email) return json(400, { error: 'email required' })
    const r = await requestOtp(store, email, via)
    // Uniform response so we don't reveal who's on the allowlist.
    return json(200, { ok: true, sent: r.sent, via })
  }

  // ── User database (allowed users) — reads for any session; WRITES are
  //    owner-only (members must not add users, change roles, or evict). ──
  if (pathname === '/v1/auth/users') {
    const me = sessionUser(req)
    if (authEnabled() && !me) return json(401, { error: 'authentication required' })
    if (method === 'GET') {
      return json(200, { users: await getUsers(store) })
    }
    if (authEnabled() && me && !(await isOwner(store, me))) {
      return json(403, { error: 'Only a household owner can manage users', code: 'OWNER_REQUIRED' })
    }
    if (method === 'POST') {
      let body: { email?: string; telegram_chat_id?: string; label?: string; role?: 'owner' | 'member'; person_entity?: string }
      try { body = (await req.json()) as any } catch { return json(400, { error: 'invalid JSON' }) }
      if (!body.email) return json(400, { error: 'email required' })
      if (body.role !== undefined && !['owner', 'member'].includes(body.role)) return json(400, { error: 'role must be owner|member' })
      // Role changes on EXISTING users go through setRole (last-owner guard).
      const existing = await getUsers(store)
      const known = existing.some(u => u.email === (body.email || '').trim().toLowerCase())
      if (known && body.role !== undefined) {
        const r = await (await import('./otp.js')).setRole(store, body.email!, body.role)
        if (!r.ok) return json(400, { error: r.error })
        const users = await addUser(store, { email: body.email!, telegram_chat_id: body.telegram_chat_id, label: body.label, person_entity: body.person_entity })
        return json(200, { ok: true, users })
      }
      const users = await addUser(store, { email: body.email, telegram_chat_id: body.telegram_chat_id, label: body.label, role: body.role, person_entity: body.person_entity })
      return json(200, { ok: true, users })
    }
    if (method === 'DELETE') {
      let body: { email?: string }
      try { body = (await req.json()) as any } catch { body = {} }
      const email = (body.email ?? new URL(req.url).searchParams.get('email') ?? '').trim()
      if (!email) return json(400, { error: 'email required' })
      const users = await removeUser(store, email)
      return json(200, { ok: true, users })
    }
  }

  if (method === 'POST' && pathname === '/v1/auth/verify-otp') {
    if (!authEnabled()) return json(200, { ok: true, authRequired: false })
    let body: { email?: string; code?: string }
    try { body = (await req.json()) as any } catch { return json(400, { error: 'invalid JSON' }) }
    const email = (body.email ?? '').trim()
    const code = (body.code ?? '').trim()
    if (!email || !code) return json(400, { error: 'email and code required' })
    const ok = await verifyOtp(store, email, code)
    if (!ok) return json(401, { error: 'invalid or expired code' })
    const token = signSession(ok)
    return json(200, { ok: true, token, username: ok }, { 'set-cookie': sessionCookie(token) })
  }

  if (method === 'POST' && pathname === '/v1/auth/logout') {
    return json(200, { ok: true }, { 'set-cookie': clearSessionCookie() })
  }

  // Lightweight gate for nginx auth_request: 200 if a valid session (or auth
  // off), 401 otherwise — so the proxy can refuse the SPA shell before serving.
  if (method === 'GET' && pathname === '/v1/auth/check') {
    if (!authEnabled()) return json(200, { ok: true })
    return sessionUser(req) ? json(200, { ok: true }) : json(401, { ok: false })
  }

  if (method === 'GET' && pathname === '/v1/auth/me') {
    if (!authEnabled()) return json(200, { authenticated: true, authRequired: false })
    const auth = req.headers.get('authorization') ?? ''
    let token = /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : ''
    if (!token) token = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE] ?? ''
    const payload = token ? verifySession(token) : null
    return payload
      ? json(200, { authenticated: true, username: payload.u })
      : json(200, { authenticated: false })
  }

  return null
}

/** Identity → display summary for /v1/auth/me-style responses. */
export function usernameOf(identity: CallerIdentity | null): string | null {
  return identity && identity.type === 'user' ? identity.username : null
}
