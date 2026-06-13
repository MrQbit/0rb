/**
 * Cloud Storage OAuth routes (Google Drive + Microsoft OneDrive).
 *   GET  /v1/oauth/cloud/{provider}/start      (session) → { url } to begin
 *   GET  /v1/oauth/cloud/{provider}/callback   (public)  ← provider redirect
 *   GET  /v1/oauth/cloud/status                (session) → per-provider status
 *   POST /v1/oauth/cloud/{provider}/disconnect (session)
 * provider ∈ { google, microsoft }
 */
import type { Store } from '../store/store.js'
import { authEnabled, verifySession, parseCookies, SESSION_COOKIE } from '../auth/session.js'
import {
  type CloudProvider, CLOUD_PROVIDERS, authorizeUrl, exchangeCode, isConnected,
  disconnect, providerConfigured, redirectUri, deviceConfigured, startDeviceFlow, pollDeviceFlow,
} from './cloudStorageOAuth.js'

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
function isProvider(p: string): p is CloudProvider { return (CLOUD_PROVIDERS as string[]).includes(p) }

export async function tryCloudOAuthRoute(req: Request, method: string, pathname: string, store: Store): Promise<Response | null> {
  if (!pathname.startsWith('/v1/oauth/cloud/')) return null

  // Public: the provider redirect lands here.
  const cb = /^\/v1\/oauth\/cloud\/(google|microsoft)\/callback$/.exec(pathname)
  if (method === 'GET' && cb) {
    const u = new URL(req.url)
    const code = u.searchParams.get('code') || ''
    const state = u.searchParams.get('state') || ''
    const p = await exchangeCode(store, code, state).catch(() => null)
    const flag = p ? `cloud=${p}` : 'cloud=error'
    return new Response(null, { status: 302, headers: { location: `/?${flag}` } })
  }

  if (!authed(req)) return json(401, { error: 'authentication required' })

  // Combined status for the Settings panel.
  if (method === 'GET' && pathname === '/v1/oauth/cloud/status') {
    const status: Record<string, { configured: boolean; device: boolean; connected: boolean; redirect_uri: string }> = {}
    for (const p of CLOUD_PROVIDERS) {
      status[p] = { configured: providerConfigured(p), device: deviceConfigured(p), connected: await isConnected(store, p), redirect_uri: redirectUri(p) }
    }
    return json(200, status)
  }

  // Device-code flow (the simple "enter a code" path).
  const devStart = /^\/v1\/oauth\/cloud\/(google|microsoft)\/device\/start$/.exec(pathname)
  if (method === 'POST' && devStart && isProvider(devStart[1]!)) {
    const p = devStart[1] as CloudProvider
    if (!deviceConfigured(p)) return json(400, { error: `Set the ${p} client ID first.` })
    const r = await startDeviceFlow(store, p)
    return 'error' in r ? json(400, r) : json(200, r)
  }
  const devPoll = /^\/v1\/oauth\/cloud\/(google|microsoft)\/device\/poll$/.exec(pathname)
  if (method === 'POST' && devPoll && isProvider(devPoll[1]!)) {
    return json(200, await pollDeviceFlow(store, devPoll[1] as CloudProvider))
  }

  const start = /^\/v1\/oauth\/cloud\/(google|microsoft)\/start$/.exec(pathname)
  if (method === 'GET' && start && isProvider(start[1]!)) {
    const p = start[1] as CloudProvider
    if (!providerConfigured(p)) return json(400, { error: `Set ${p} Client ID/Secret + RAK00N_PUBLIC_URL first.`, redirect_uri: redirectUri(p) })
    return json(200, { url: await authorizeUrl(store, p), redirect_uri: redirectUri(p) })
  }
  const disc = /^\/v1\/oauth\/cloud\/(google|microsoft)\/disconnect$/.exec(pathname)
  if (method === 'POST' && disc && isProvider(disc[1]!)) {
    await disconnect(store, disc[1] as CloudProvider)
    return json(200, { ok: true })
  }
  return null
}
