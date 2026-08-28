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

  // ── Claim ceremony (v0.2 S2): first-owner enrollment. These answer only
  //    while NO owner exists; afterwards they say "claimed" and nothing else.
  if (method === 'GET' && (pathname === '/v1/claim' || pathname === '/v1/claim/qr.svg')) {
    const { currentClaim } = await import('./claim.js')
    const host = (req.headers.get('host') || 'orb.local').split(':')[0]!
    const c = await currentClaim(store, host)
    if (pathname === '/v1/claim') return json(200, c ? { available: true, ...c } : { available: false })
    if (!c) return json(404, { error: 'already claimed' })
    const QR = await import('qrcode')
    const svg: string = await (QR as any).toString(c.uri, {
      type: 'svg', margin: 1, errorCorrectionLevel: 'M',
      color: { dark: '#e9f1e2ff', light: '#00000000' },
    })
    return new Response(svg, { status: 200, headers: { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' } })
  }
  if (method === 'POST' && pathname === '/v1/claim') {
    const { redeemClaim } = await import('./claim.js')
    const b = (await req.json().catch(() => ({}))) as any
    const r = await redeemClaim(store, String(b.code || ''), String(b.email || ''))
    if (!r.ok) return json(400, { error: r.error })
    return json(200, { ok: true, token: r.token }, { 'set-cookie': sessionCookie(r.token!) })
  }

  // ── Profiles v2: identity, avatars, per-member app permissions ──
  if (pathname === '/v1/profile' && method === 'POST') {
    const me = sessionUser(req)
    if (authEnabled() && !me) return json(401, { error: 'authentication required' })
    const b = (await req.json().catch(() => ({}))) as any
    // Members edit themselves; owners may edit anyone; only owners touch permissions.
    const target = String(b.email || me || '').toLowerCase()
    const owner = !authEnabled() || (me ? await isOwner(store, me) : false)
    if (target !== (me || '').toLowerCase() && !owner) return json(403, { error: 'you can only edit your own profile' })
    const patch: any = {}
    if (typeof b.first_name === 'string') patch.first_name = b.first_name.trim().slice(0, 40)
    if (typeof b.last_name === 'string') patch.last_name = b.last_name.trim().slice(0, 40)
    if (typeof b.theme === 'string') patch.theme = b.theme.trim().slice(0, 20)
    if (Array.isArray(b.disabled_apps)) {
      if (!owner) return json(403, { error: 'only an owner can change app access' })
      const { APP_GROUPS } = await import('./appGroups.js')
      if (await isOwner(store, target)) return json(400, { error: 'owners always have full access' })
      patch.disabled_apps = b.disabled_apps.map(String).filter((a: string) => a in APP_GROUPS)
    }
    const { updateUser } = await import('./otp.js')
    const u = await updateUser(store, target, patch)
    return u ? json(200, { ok: true, user: u }) : json(404, { error: 'no such member' })
  }
  if (pathname === '/v1/profile/avatar') {
    const me = sessionUser(req)
    if (method === 'GET') {
      const email = new URL(req.url).searchParams.get('email') || me || ''
      const raw = await store.getKv(`profile:avatar:${email.toLowerCase()}`).catch(() => null)
      if (!raw) return json(404, { error: 'no avatar' })
      const m = raw.match(/^data:(image\/[a-z+]+);base64,(.+)$/)
      if (!m) return json(404, { error: 'no avatar' })
      return new Response(Buffer.from(m[2]!, 'base64'), { status: 200, headers: { 'content-type': m[1]!, 'cache-control': 'private, max-age=300' } })
    }
    if (method === 'POST') {
      if (authEnabled() && !me) return json(401, { error: 'authentication required' })
      const b = (await req.json().catch(() => ({}))) as any
      const target = String(b.email || me || '').toLowerCase()
      if (target !== (me || '').toLowerCase() && authEnabled() && me && !(await isOwner(store, me))) {
        return json(403, { error: 'you can only change your own picture' })
      }
      const data = String(b.data || '')
      if (!/^data:image\/(png|jpeg|webp);base64,/.test(data)) return json(400, { error: 'a png/jpeg/webp data-uri is required' })
      if (data.length > 300_000) return json(400, { error: 'image too large — the console resizes to 256px, use that' })
      await store.putKv(`profile:avatar:${target}`, data, 0)
      return json(200, { ok: true })
    }
  }
  // App-group catalog for the Settings toggles.
  if (pathname === '/v1/profile/apps' && method === 'GET') {
    const { APP_GROUPS } = await import('./appGroups.js')
    return json(200, { apps: Object.entries(APP_GROUPS).map(([id, g]) => ({ id, label: g.label, desc: g.desc })) })
  }

  // ── Invitations: owner mints a link; opening it joins the household. ──
  if (pathname === '/v1/invites' && method === 'POST') {
    const me = sessionUser(req)
    if (authEnabled() && (!me || !(await isOwner(store, me)))) return json(403, { error: 'owner only' })
    const b = (await req.json().catch(() => ({}))) as any
    const { createInvite } = await import('./invites.js')
    const inv = await createInvite(store, me || 'owner', b?.note)
    const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || 'orb.local'
    const proto = /^(localhost|127\.)/.test(host) ? 'http' : 'https'
    return json(200, { ...inv, url: `${proto}://${host}/login.html?invite=${inv.token}` })
  }
  if (pathname === '/v1/invites' && method === 'GET') {
    const me = sessionUser(req)
    if (authEnabled() && (!me || !(await isOwner(store, me)))) return json(403, { error: 'owner only' })
    const { listInvites } = await import('./invites.js')
    return json(200, { invites: await listInvites(store) })
  }
  {
    const im = pathname.match(/^\/v1\/invites\/([A-Za-z0-9_-]{8,32})$/)
    if (im && method === 'DELETE') {
      const me = sessionUser(req)
      if (authEnabled() && (!me || !(await isOwner(store, me)))) return json(403, { error: 'owner only' })
      const { revokeInvite } = await import('./invites.js')
      await revokeInvite(store, im[1]!)
      return json(200, { ok: true })
    }
    // Public: the login page checks the invite and shows who's inviting.
    if (im && method === 'GET') {
      const { readInvite } = await import('./invites.js')
      const inv = await readInvite(store, im[1]!)
      return json(200, inv
        ? { valid: true, household: process.env.ORB2_ADVERTISE_NAME || 'Orb', invited_by: inv.invited_by, note: inv.note }
        : { valid: false })
    }
  }
  // Public: accept — creates the member; sign-in still proves the email by OTP.
  if (pathname === '/v1/invites/accept' && method === 'POST') {
    const b = (await req.json().catch(() => ({}))) as any
    const { acceptInvite } = await import('./invites.js')
    const r = await acceptInvite(store, String(b.token || ''), String(b.email || ''), b.first_name ? String(b.first_name) : undefined)
    if (!r.ok) return json(400, { error: r.error })
    await requestOtp(store, String(b.email), 'email').catch(() => { /* they can request again */ })
    return json(200, { ok: true, next: 'a sign-in code is on its way to that email' })
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
    if (!payload) return json(200, { authenticated: false })
    let theme: string | undefined
    try { const { findUser } = await import('./otp.js'); theme = (await findUser(store, payload.u))?.theme } catch { /* optional */ }
    return json(200, { authenticated: true, username: payload.u, theme })
  }

  return null
}

/** Identity → display summary for /v1/auth/me-style responses. */
export function usernameOf(identity: CallerIdentity | null): string | null {
  return identity && identity.type === 'user' ? identity.username : null
}
