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
import { authorizeUrl, exchangeCode, isConnected, disconnect, getUserToken, spotifyOAuthConfigured, redirectUri } from './spotifyOAuth.js'

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

export async function trySpotifyOAuthRoute(req: Request, method: string, pathname: string, store: Store): Promise<Response | null> {
  if (!pathname.startsWith('/v1/oauth/spotify/')) return null

  // Public: the Spotify redirect lands here.
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

  if (method === 'GET' && pathname === '/v1/oauth/spotify/start') {
    if (!spotifyOAuthConfigured()) return json(400, { error: 'Set Spotify Client ID/Secret + RAK00N_PUBLIC_URL first.', redirect_uri: redirectUri() })
    return json(200, { url: await authorizeUrl(store), redirect_uri: redirectUri() })
  }
  if (method === 'GET' && pathname === '/v1/oauth/spotify/status') {
    return json(200, { connected: await isConnected(store), configured: spotifyOAuthConfigured(), redirect_uri: redirectUri() })
  }
  if (method === 'GET' && pathname === '/v1/oauth/spotify/token') {
    const t = await getUserToken(store)
    return t ? json(200, { token: t }) : json(404, { error: 'not connected' })
  }
  if (method === 'POST' && pathname === '/v1/oauth/spotify/disconnect') {
    await disconnect(store)
    return json(200, { ok: true })
  }
  return null
}
