/**
 * Spotify OAuth + control routes.
 *   GET  /v1/oauth/spotify/start      (session) → { url } to begin the flow
 *   GET  /v1/oauth/spotify/callback   (public)  ← Spotify redirect; stores token
 *   GET  /v1/oauth/spotify/status     (session) → { connected }
 *   GET  /v1/oauth/spotify/token      (session) → { token } for the Web Playback SDK
 *   POST /v1/oauth/spotify/disconnect (session)
 */
import type { Store } from '../store/store.js'
import { authEnabled, verifySession, parseCookies, SESSION_COOKIE } from '../auth/session.js'
import { authorizeUrl, exchangeCode, isConnected, disconnect, getUserToken, spotifyOAuthConfigured, redirectUri, relayAvailable, relayStartUrl, claimRelayBlob } from './spotifyOAuth.js'

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}
function authed(req: Request): boolean {
  if (!authEnabled()) return true
  const a = req.headers.get('authorization') ?? ''
  let token = /^Bearer\s+/i.test(a) ? a.replace(/^Bearer\s+/i, '').trim() : ''
  if (!token) token = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE] ?? ''
  return !!(token && verifySession(token))
}

function sessionMember(req: Request): string | undefined {
  const a = req.headers.get('authorization') ?? ''
  let token = /^Bearer\s+/i.test(a) ? a.replace(/^Bearer\s+/i, '').trim() : ''
  if (!token) token = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE] ?? ''
  return (token && verifySession(token)?.u) || undefined
}

export async function trySpotifyOAuthRoute(req: Request, method: string, pathname: string, store: Store): Promise<Response | null> {
  if (!pathname.startsWith('/v1/oauth/spotify/')) return null

  // Public: the RELAY bounce lands here — the browser carries an AES-sealed
  // blob; we claim the real tokens server-to-server (TV-style linking).
  if (method === 'GET' && pathname === '/v1/oauth/spotify/relay') {
    const u = new URL(req.url)
    const blob = u.searchParams.get('orb2_relay') || ''
    const nonce = u.searchParams.get('state') || ''
    const ok = blob && nonce && await claimRelayBlob(store, blob, nonce)
    return new Response(null, { status: 302, headers: { location: `/?spotify=${ok ? 'connected' : 'error'}` } })
  }

  // Public: the Spotify redirect lands here (own-app mode).
  if (method === 'GET' && pathname === '/v1/oauth/spotify/callback') {
    const u = new URL(req.url)
    const code = u.searchParams.get('code') || ''
    const state = u.searchParams.get('state') || ''
    let okMsg = 'spotify=connected'
    if (!code || !(await exchangeCode(store, code, state))) okMsg = 'spotify=error'
    // Bounce back to the orb with a status flag.
    return new Response(null, { status: 302, headers: { location: `/?${okMsg}` } })
  }

  if (!authed(req)) return json(401, { error: 'authentication required' })
  const member = sessionMember(req)

  if (method === 'GET' && pathname === '/v1/oauth/spotify/start') {
    // Own-app mode wins when this house registered its own Spotify app;
    // otherwise the default is the relay — one shared 0rb app, zero setup.
    if (spotifyOAuthConfigured()) return json(200, { url: await authorizeUrl(store, member), redirect_uri: redirectUri(), mode: 'own' })
    if (await relayAvailable()) {
      const r = await relayStartUrl(store, member, req)
      return 'url' in r ? json(200, { ...r, mode: 'relay' }) : json(400, r)
    }
    return json(400, { error: 'Spotify linking is not available yet: neither the shared 0rb app (relay) nor a house app credential is configured.' })
  }
  if (method === 'GET' && pathname === '/v1/oauth/spotify/status') {
    const own = spotifyOAuthConfigured()
    const relay = own ? false : await relayAvailable()
    return json(200, { connected: await isConnected(store, member), configured: own || relay, mode: own ? 'own' : relay ? 'relay' : 'none', redirect_uri: redirectUri() })
  }
  if (method === 'GET' && pathname === '/v1/oauth/spotify/token') {
    const t = await getUserToken(store, member)
    return t ? json(200, { token: t }) : json(404, { error: 'not connected' })
  }
  if (method === 'POST' && pathname === '/v1/oauth/spotify/claim-blob') {
    // Popup completion: the console hands over the sealed blob it received
    // by postMessage; session-authed, nonce-gated, single-use.
    const b = (await req.json().catch(() => ({}))) as any
    const ok = b?.blob && b?.istate && await claimRelayBlob(store, String(b.blob), String(b.istate))
    return ok ? json(200, { ok: true }) : json(400, { error: 'claim failed — reconnect' })
  }
  if (method === 'POST' && pathname === '/v1/oauth/spotify/disconnect') {
    await disconnect(store, member)
    return json(200, { ok: true })
  }
  return null
}
