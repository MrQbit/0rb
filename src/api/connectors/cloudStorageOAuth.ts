/**
 * Cloud Storage user OAuth (Authorization Code) — connect the user's Google
 * Drive and/or Microsoft OneDrive so the agent can search and pull files into
 * the workspace. Generalised over both providers; tokens are stored per box
 * (single user) in the kv store and refreshed on demand.
 *
 * Redirect URIs (register these in the Google / Microsoft app):
 *   <ORB2_PUBLIC_URL>/v1/oauth/cloud/google/callback
 *   <ORB2_PUBLIC_URL>/v1/oauth/cloud/microsoft/callback
 */
import type { Store } from '../store/store.js'

export type CloudProvider = 'google' | 'microsoft'
export const CLOUD_PROVIDERS: CloudProvider[] = ['google', 'microsoft']

// One APP credential per provider; each MEMBER's account link is keyed to
// them, with the pre-multiuser household token as fallback.
const TOK_KEY = (p: CloudProvider) => `cloud:oauth:${p}`
const tokKey = (p: CloudProvider, member?: string) => (member ? `cloud:oauth:${p}:${member}` : TOK_KEY(p))
const STATE_KEY = (s: string) => `cloud:oauthstate:${s}`

interface ProviderCfg {
  clientId: string
  clientSecret: string
  authUrl: string
  tokenUrl: string
  deviceCodeUrl: string
  scope: string
  // Extra params appended to the authorize URL (e.g. Google's offline access).
  authExtra: Record<string, string>
}

const DEVICE_KEY = (p: CloudProvider) => `cloud:device:${p}`

function providerCfg(p: CloudProvider): ProviderCfg {
  if (p === 'google') {
    return {
      clientId: (process.env.ORB2_GOOGLE_CLIENT_ID || '').trim(),
      clientSecret: (process.env.ORB2_GOOGLE_CLIENT_SECRET || '').trim(),
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      // Device-code endpoint (RFC 8628) — "TV & limited input" client, no secret.
      deviceCodeUrl: 'https://oauth2.googleapis.com/device/code',
      // One connection lights up Drive (files), Calendar (events) + Gmail (mail).
      scope: 'openid email https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.readonly',
      authExtra: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    }
  }
  return {
    clientId: (process.env.ORB2_MS_CLIENT_ID || '').trim(),
    clientSecret: (process.env.ORB2_MS_CLIENT_SECRET || '').trim(),
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    deviceCodeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode',
    // OneDrive (files) + Outlook (mail) + Calendar.
    scope: 'offline_access User.Read Files.Read Mail.Read Calendars.Read',
    authExtra: { prompt: 'select_account' },
  }
}

export function providerConfigured(p: CloudProvider): boolean {
  const c = providerCfg(p)
  return !!(c.clientId && c.clientSecret && (process.env.ORB2_PUBLIC_URL || '').trim())
}
export function anyCloudConfigured(): boolean {
  // Either the full redirect flow (client+secret+public URL) OR just a device
  // client ID is enough to offer a connection and enable the tools.
  return CLOUD_PROVIDERS.some(p => providerConfigured(p) || deviceConfigured(p))
}

export function redirectUri(p: CloudProvider): string {
  const base = (process.env.ORB2_PUBLIC_URL || '').replace(/\/+$/, '')
  return `${base}/v1/oauth/cloud/${p}/callback`
}

export async function authorizeUrl(store: Store, p: CloudProvider, member?: string): Promise<string> {
  const c = providerCfg(p)
  const state = `${p}.${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  await store.putKv(STATE_KEY(state), JSON.stringify({ p, member: member || '' }), 600).catch(() => {})
  const params = new URLSearchParams({
    client_id: c.clientId,
    response_type: 'code',
    redirect_uri: redirectUri(p),
    scope: c.scope,
    state,
    ...c.authExtra,
  })
  return `${c.authUrl}?${params.toString()}`
}

type Tokens = { access_token: string; refresh_token: string; expires_at: number }

export async function exchangeCode(store: Store, code: string, state: string): Promise<CloudProvider | null> {
  const rawState = await store.getKv(STATE_KEY(state)).catch(() => null)
  let p: CloudProvider | null = null
  let member = ''
  try { const j = JSON.parse(rawState || ''); p = j.p; member = j.member || '' }
  catch { p = rawState as CloudProvider | null }   // legacy plain-provider state
  if (!p || !CLOUD_PROVIDERS.includes(p)) return null
  await store.delKv(STATE_KEY(state)).catch(() => {})
  const c = providerCfg(p)
  const r = await fetch(c.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(p),
      client_id: c.clientId,
      client_secret: c.clientSecret,
      ...(p === 'microsoft' ? { scope: c.scope } : {}),
    }).toString(),
  })
  if (!r.ok) return null
  const d = (await r.json()) as any
  if (!d.access_token) return null
  const t: Tokens = {
    access_token: d.access_token,
    refresh_token: d.refresh_token || '',
    expires_at: Date.now() + ((d.expires_in || 3600) - 60) * 1000,
  }
  await store.putKv(tokKey(p, member || undefined), JSON.stringify(t), 60 * 60 * 24 * 365)
  return p
}


// ── TV-style linking via the orb2.app relay (same pattern as Spotify) ────
// ONE Google / ONE Microsoft app registered by the 0rb project; secrets
// live only on the relay. /start sends the browser there, the sealed blob
// bounces back to /v1/oauth/cloud/relay, and we claim tokens server-side.
const RELAY_KEY = (nonce: string) => `cloud:relay:${nonce}`

export function relayUrl(): string {
  return (process.env.ORB2_RELAY_URL || process.env.ORB2_BROKER_URL || 'https://orb2.app').replace(/\/+$/, '')
}

const relayProbes = new Map<CloudProvider, { ok: boolean; ts: number }>()
export async function relayAvailable(p: CloudProvider): Promise<boolean> {
  const c = relayProbes.get(p)
  if (c && Date.now() - c.ts < 600_000) return c.ok
  let ok = false
  try {
    const r = await fetch(`${relayUrl()}/api/oauth/start?provider=${p}`, { redirect: 'manual', signal: AbortSignal.timeout(6000) })
    ok = r.status === 400   // "redirect must be…" = configured; 503 = not
  } catch { ok = false }
  relayProbes.set(p, { ok, ts: Date.now() })
  return ok
}

export async function relayStartUrl(store: Store, p: CloudProvider, member?: string, req?: Request): Promise<{ url: string } | { error: string }> {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36)
  await store.putKv(RELAY_KEY(nonce), JSON.stringify({ p, member: member || '' }), 600)
  const origin = req?.headers.get('origin') || ''
  const popupUrl = `${relayUrl()}/api/oauth/start?provider=${p}&popup=1&istate=${nonce}${origin ? `&origin=${encodeURIComponent(origin)}` : ''}`
  const { bounceBase } = await import('./relayBounce.js')
  const base = await bounceBase(store, req)
  const redirectUrl = base
    ? `${relayUrl()}/api/oauth/start?provider=${p}&redirect=${encodeURIComponent(`${base}/v1/oauth/cloud/relay`)}&istate=${nonce}`
    : null
  return { url: popupUrl, ...(redirectUrl ? { redirect_url: redirectUrl } : {}) } as any
}

export async function claimRelayBlob(store: Store, blob: string, nonce: string): Promise<CloudProvider | null> {
  const raw = await store.getKv(RELAY_KEY(nonce)).catch(() => null)
  if (!raw) return null
  await store.delKv(RELAY_KEY(nonce)).catch(() => {})
  let p: CloudProvider | null = null
  let member = ''
  try { const j = JSON.parse(raw); p = j.p; member = j.member || '' } catch { return null }
  if (!p || !CLOUD_PROVIDERS.includes(p)) return null
  const r = await fetch(`${relayUrl()}/api/oauth/claim`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ blob }), signal: AbortSignal.timeout(10_000),
  })
  if (!r.ok) return null
  const d = (await r.json()) as any
  const tk = d?.tokens
  if (!tk?.access_token) return null
  const t: Tokens & { via?: string } = {
    access_token: tk.access_token,
    refresh_token: tk.refresh_token || '',
    expires_at: Date.now() + ((tk.expires_in || 3600) - 60) * 1000,
    via: 'relay',
  }
  await store.putKv(tokKey(p, member || undefined), JSON.stringify(t), 60 * 60 * 24 * 365)
  return p
}

export async function isConnected(store: Store, p: CloudProvider, member?: string): Promise<boolean> {
  if (member && await store.getKv(tokKey(p, member)).catch(() => null)) return true
  return !!(await store.getKv(TOK_KEY(p)).catch(() => null))
}

export async function disconnect(store: Store, p: CloudProvider, member?: string): Promise<void> {
  if (member) await store.delKv(tokKey(p, member)).catch(() => {})
  await store.delKv(TOK_KEY(p)).catch(() => {})
}

/** Valid user access token (refreshes if expired). null if not connected.
 *  Reads the member's own link first, then the household fallback. */
export async function getToken(store: Store, p: CloudProvider, member?: string): Promise<string | null> {
  let key = tokKey(p, member)
  let raw = member ? await store.getKv(key).catch(() => null) : null
  if (!raw) { key = TOK_KEY(p); raw = await store.getKv(TOK_KEY(p)).catch(() => null) }
  if (!raw) return null
  let t: Tokens
  try { t = JSON.parse(raw) } catch { return null }
  if (Date.now() < t.expires_at && t.access_token) return t.access_token
  if (!t.refresh_token) return null
  if ((t as any).via === 'relay') {
    try {
      const rr = await fetch(`${relayUrl()}/api/oauth/refresh`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: p, refresh_token: t.refresh_token }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!rr.ok) return null
      const rd = (await rr.json()) as any
      const tk = rd?.tokens
      if (!tk?.access_token) return null
      const nt = { access_token: tk.access_token, refresh_token: tk.refresh_token || t.refresh_token,
        expires_at: Date.now() + ((tk.expires_in || 3600) - 60) * 1000, via: 'relay' }
      await store.putKv(key, JSON.stringify(nt), 60 * 60 * 24 * 365)
      return nt.access_token
    } catch { return null }
  }
  const c = providerCfg(p)
  const r = await fetch(c.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: t.refresh_token,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      ...(p === 'microsoft' ? { scope: c.scope } : {}),
    }).toString(),
  })
  if (!r.ok) return null
  const d = (await r.json()) as any
  if (!d.access_token) return null
  const nt: Tokens = {
    access_token: d.access_token,
    refresh_token: d.refresh_token || t.refresh_token,
    expires_at: Date.now() + ((d.expires_in || 3600) - 60) * 1000,
  }
  await store.putKv(key, JSON.stringify(nt), 60 * 60 * 24 * 365)
  return nt.access_token
}

// ── Device Authorization Flow (RFC 8628) — the "TV login" path ───────────────
// Far simpler for end users than the redirect dance: orb2 shows a code + URL,
// the user approves on their phone, we poll for the token. Needs only a public
// client_id (no secret, no redirect URI). One connection grants all the scopes
// above → lights up files + mail + calendar widgets at once.

/** Device flow only needs a client_id (no secret, no public URL). */
export function deviceConfigured(p: CloudProvider): boolean {
  return !!providerCfg(p).clientId
}

export interface DeviceStart {
  user_code: string
  verification_url: string
  interval: number
  expires_in: number
  message?: string
}

export async function startDeviceFlow(store: Store, p: CloudProvider): Promise<DeviceStart | { error: string }> {
  const c = providerCfg(p)
  if (!c.clientId) return { error: `${p} client ID not configured` }
  const r = await fetch(c.deviceCodeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, scope: c.scope }).toString(),
  })
  if (!r.ok) return { error: `device start failed (${r.status}): ${(await r.text()).slice(0, 200)}` }
  const d = (await r.json()) as any
  // Store the device_code (+ interval) to poll against; short TTL = expiry.
  await store.putKv(DEVICE_KEY(p), JSON.stringify({ device_code: d.device_code, interval: d.interval || 5 }), (d.expires_in || 600))
  return {
    user_code: d.user_code,
    verification_url: d.verification_url || d.verification_uri || d.verification_uri_complete || '',
    interval: d.interval || 5,
    expires_in: d.expires_in || 600,
    message: d.message,
  }
}

/** Poll once. Returns 'connected' | 'pending' | 'slow_down' | 'expired' | 'error'. */
export async function pollDeviceFlow(store: Store, p: CloudProvider): Promise<{ status: string; error?: string }> {
  const raw = await store.getKv(DEVICE_KEY(p)).catch(() => null)
  if (!raw) return { status: 'expired' }
  let dc: { device_code: string }
  try { dc = JSON.parse(raw) } catch { return { status: 'expired' } }
  const c = providerCfg(p)
  const r = await fetch(c.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.clientId,
      device_code: dc.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      ...(c.clientSecret ? { client_secret: c.clientSecret } : {}),
    }).toString(),
  })
  const d = (await r.json().catch(() => ({}))) as any
  if (r.ok && d.access_token) {
    const t: Tokens = {
      access_token: d.access_token,
      refresh_token: d.refresh_token || '',
      expires_at: Date.now() + ((d.expires_in || 3600) - 60) * 1000,
    }
    await store.putKv(TOK_KEY(p), JSON.stringify(t), 60 * 60 * 24 * 365)
    await store.delKv(DEVICE_KEY(p)).catch(() => {})
    return { status: 'connected' }
  }
  const err = String(d.error || '')
  if (err === 'authorization_pending') return { status: 'pending' }
  if (err === 'slow_down') return { status: 'slow_down' }
  if (err === 'expired_token' || err === 'expired') { await store.delKv(DEVICE_KEY(p)).catch(() => {}); return { status: 'expired' } }
  if (err === 'access_denied') { await store.delKv(DEVICE_KEY(p)).catch(() => {}); return { status: 'error', error: 'access denied' } }
  return { status: 'pending' } // unknown transient → keep polling
}
