/**
 * Spotify user OAuth (Authorization Code) — connect the user's account so the
 * agent can CONTROL playback (play/pause/skip, play a specific track) on their
 * active device or the in-browser Web Playback SDK device, and read their
 * library/playlists. Full, ad-free tracks (Premium required for SDK control).
 *
 * Tokens are stored per box (single user) in the kv store and refreshed on
 * demand. The redirect URI must be registered in the Spotify app and equals
 * <ORB2_PUBLIC_URL>/v1/oauth/spotify/callback.
 */
import type { Store } from '../store/store.js'

// One APP credential for the whole house (Client ID/Secret, set once in
// Settings); each MEMBER links their own Spotify account — tokens are keyed
// per member, with the pre-multiuser household token as a fallback.
const TOK_KEY = 'spotify:oauth'
const tokKey = (member?: string) => (member ? `spotify:oauth:${member}` : TOK_KEY)
const STATE_KEY = (s: string) => `spotify:oauthstate:${s}`
const SCOPES = [
  'streaming', 'user-read-email', 'user-read-private',
  'user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing',
  'playlist-read-private', 'user-library-read',
].join(' ')

function clientId() { return (process.env.ORB2_SPOTIFY_CLIENT_ID || '').trim() }
function clientSecret() { return (process.env.ORB2_SPOTIFY_CLIENT_SECRET || '').trim() }
export function spotifyOAuthConfigured() { return !!(clientId() && clientSecret() && (process.env.ORB2_PUBLIC_URL || '').trim()) }

export function redirectUri(): string {
  const base = (process.env.ORB2_PUBLIC_URL || '').replace(/\/+$/, '')
  return `${base}/v1/oauth/spotify/callback`
}

export async function authorizeUrl(store: Store, member?: string): Promise<string> {
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36)
  await store.putKv(STATE_KEY(state), JSON.stringify({ member: member || '' }), 600).catch(() => {})
  const p = new URLSearchParams({
    client_id: clientId(), response_type: 'code', redirect_uri: redirectUri(),
    scope: SCOPES, state, show_dialog: 'false',
  })
  return `https://accounts.spotify.com/authorize?${p.toString()}`
}

type Tokens = { access_token: string; refresh_token: string; expires_at: number }

export async function exchangeCode(store: Store, code: string, state: string): Promise<boolean> {
  const ok = await store.getKv(STATE_KEY(state)).catch(() => null)
  if (!ok) return false
  let member = ''
  try { member = JSON.parse(ok).member || '' } catch { /* legacy '1' state */ }
  await store.delKv(STATE_KEY(state)).catch(() => {})
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64') },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() }).toString(),
  })
  if (!r.ok) return false
  const d = (await r.json()) as any
  const t: Tokens = { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + (d.expires_in - 60) * 1000 }
  await store.putKv(tokKey(member || undefined), JSON.stringify(t), 60 * 60 * 24 * 365)
  return true
}


// ── TV-style linking via the orb2.app relay ──────────────────────────────
// The 0rb project registers ONE Spotify app; its secret lives only on the
// relay (orb2.app). An orb sends the browser to the relay's /start, the
// relay handles consent + code exchange, bounces back an AES-sealed blob,
// and the orb claims the real tokens server-to-server. No per-install app
// registration, no local secret — like linking Spotify on a TV.
const RELAY_KEY = (nonce: string) => `spotify:relay:${nonce}`

export function relayUrl(): string {
  return (process.env.ORB2_RELAY_URL || process.env.ORB2_BROKER_URL || 'https://orb2.app').replace(/\/+$/, '')
}

let relayProbe: { ok: boolean; ts: number } | null = null
/** Is Spotify configured on the relay? (probed, cached 10 min) */
export async function relayAvailable(): Promise<boolean> {
  if (relayProbe && Date.now() - relayProbe.ts < 600_000) return relayProbe.ok
  let ok = false
  try {
    const r = await fetch(`${relayUrl()}/api/oauth/start?provider=spotify`, { redirect: 'manual', signal: AbortSignal.timeout(6000) })
    // 400 "redirect must be…" = provider configured, our probe just lacked a
    // redirect; 503 = not configured on the relay.
    ok = r.status === 400
  } catch { ok = false }
  relayProbe = { ok, ts: Date.now() }
  return ok
}

/** Begin a relay link for this member. The bounce host prefers whatever the
 *  browser is already on (see relayBounce.ts — DNS-rebind-filtering routers
 *  make the device hostname unresolvable on some LANs). */
export async function relayStartUrl(store: Store, member?: string, req?: Request): Promise<{ url: string } | { error: string }> {
  const { bounceBase } = await import('./relayBounce.js')
  const base = await bounceBase(store, req)
  if (!base) return { error: 'Linking needs a reachable HTTPS address — connect Tailscale or enroll the device URL (Settings → General).' }
  const ret = `${base}/v1/oauth/spotify/relay`
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36)
  await store.putKv(RELAY_KEY(nonce), JSON.stringify({ member: member || '' }), 600)
  return { url: `${relayUrl()}/api/oauth/start?provider=spotify&redirect=${encodeURIComponent(ret)}&istate=${nonce}` }
}

/** The relay bounced back: claim the sealed blob and store the member's tokens. */
export async function claimRelayBlob(store: Store, blob: string, nonce: string): Promise<boolean> {
  const raw = await store.getKv(RELAY_KEY(nonce)).catch(() => null)
  if (!raw) return false
  await store.delKv(RELAY_KEY(nonce)).catch(() => {})
  let member = ''
  try { member = JSON.parse(raw).member || '' } catch { /* household */ }
  const r = await fetch(`${relayUrl()}/api/oauth/claim`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ blob }), signal: AbortSignal.timeout(10_000),
  })
  if (!r.ok) return false
  const d = (await r.json()) as any
  const tk = d?.tokens
  if (!tk?.access_token) return false
  const t: Tokens & { via?: string } = {
    access_token: tk.access_token,
    refresh_token: tk.refresh_token || '',
    expires_at: Date.now() + ((tk.expires_in || 3600) - 60) * 1000,
    via: 'relay',
  }
  await store.putKv(tokKey(member || undefined), JSON.stringify(t), 60 * 60 * 24 * 365)
  return true
}

export async function isConnected(store: Store, member?: string): Promise<boolean> {
  if (member && await store.getKv(tokKey(member)).catch(() => null)) return true
  return !!(await store.getKv(TOK_KEY).catch(() => null))
}

export async function disconnect(store: Store, member?: string): Promise<void> {
  if (member) await store.delKv(tokKey(member)).catch(() => {})
  await store.delKv(TOK_KEY).catch(() => {})
}

/** Valid user access token (refreshes if expired). null if not connected.
 *  Reads the member's own link first, then the household fallback. */
export async function getUserToken(store: Store, member?: string): Promise<string | null> {
  let key = tokKey(member)
  let raw = member ? await store.getKv(key).catch(() => null) : null
  if (!raw) { key = TOK_KEY; raw = await store.getKv(TOK_KEY).catch(() => null) }
  if (!raw) return null
  let t: Tokens
  try { t = JSON.parse(raw) } catch { return null }
  if (Date.now() < t.expires_at && t.access_token) return t.access_token
  // Relay-linked tokens refresh through the relay — only it holds the secret.
  if ((t as any).via === 'relay') {
    if (!t.refresh_token) return null
    try {
      const rr = await fetch(`${relayUrl()}/api/oauth/refresh`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'spotify', refresh_token: t.refresh_token }),
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
  // Own-app tokens refresh directly with the local credential.
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64') },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token }).toString(),
  })
  if (!r.ok) return null
  const d = (await r.json()) as any
  const nt: Tokens = { access_token: d.access_token, refresh_token: d.refresh_token || t.refresh_token, expires_at: Date.now() + (d.expires_in - 60) * 1000 }
  await store.putKv(key, JSON.stringify(nt), 60 * 60 * 24 * 365)
  return nt.access_token
}

/** Thin wrapper for Spotify Web API calls with the user token. */
export async function spotifyApi(store: Store, path: string, init?: RequestInit, member?: string): Promise<Response> {
  const tok = await getUserToken(store, member)
  if (!tok) throw new Error('Spotify account not connected')
  return fetch(`https://api.spotify.com/v1${path}`, {
    ...init,
    headers: { ...(init?.headers || {}), authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
  })
}
