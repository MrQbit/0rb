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

const TOK_KEY = 'spotify:oauth'
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

export async function authorizeUrl(store: Store): Promise<string> {
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36)
  await store.putKv(STATE_KEY(state), '1', 600).catch(() => {})
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
  await store.delKv(STATE_KEY(state)).catch(() => {})
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64') },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() }).toString(),
  })
  if (!r.ok) return false
  const d = (await r.json()) as any
  const t: Tokens = { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + (d.expires_in - 60) * 1000 }
  await store.putKv(TOK_KEY, JSON.stringify(t), 60 * 60 * 24 * 365)
  return true
}

export async function isConnected(store: Store): Promise<boolean> {
  return !!(await store.getKv(TOK_KEY).catch(() => null))
}

export async function disconnect(store: Store): Promise<void> {
  await store.delKv(TOK_KEY).catch(() => {})
}

/** Valid user access token (refreshes if expired). null if not connected. */
export async function getUserToken(store: Store): Promise<string | null> {
  const raw = await store.getKv(TOK_KEY).catch(() => null)
  if (!raw) return null
  let t: Tokens
  try { t = JSON.parse(raw) } catch { return null }
  if (Date.now() < t.expires_at && t.access_token) return t.access_token
  // refresh
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64') },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token }).toString(),
  })
  if (!r.ok) return null
  const d = (await r.json()) as any
  const nt: Tokens = { access_token: d.access_token, refresh_token: d.refresh_token || t.refresh_token, expires_at: Date.now() + (d.expires_in - 60) * 1000 }
  await store.putKv(TOK_KEY, JSON.stringify(nt), 60 * 60 * 24 * 365)
  return nt.access_token
}

/** Thin wrapper for Spotify Web API calls with the user token. */
export async function spotifyApi(store: Store, path: string, init?: RequestInit): Promise<Response> {
  const tok = await getUserToken(store)
  if (!tok) throw new Error('Spotify account not connected')
  return fetch(`https://api.spotify.com/v1${path}`, {
    ...init,
    headers: { ...(init?.headers || {}), authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
  })
}
