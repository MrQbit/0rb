/**
 * Client side of the central OAuth relay (orb2.app/api/oauth/*).
 *
 * Lets the owner connect Google / Microsoft / Spotify with one tap, without
 * registering their own developer apps:
 *   browser → /v1/oauth/connect?provider=X
 *           → relay /start → provider consent → relay /callback
 *           → browser back to /v1/oauth/return?orb2_relay=<blob>
 *           → we POST the blob to relay /claim, get the tokens, store them where
 *             the connectors read them, and bounce the user back to the console.
 *
 * Tokens are saved in the SAME shape/keys the existing connectors use, so
 * Drive/Calendar/Spotify just work afterwards. Off unless ORB2_RELAY_URL (or the
 * default https://orb2.app) is reachable.
 */
import crypto from 'node:crypto'
import type { Store } from '../store/store.js'

export const RELAY_PROVIDERS = ['google', 'microsoft', 'spotify'] as const

function relayBase(): string {
  return (process.env.ORB2_RELAY_URL || 'https://orb2.app').replace(/\/+$/, '')
}

/** The relay /start URL the browser is redirected to. */
export function relayStartUrl(provider: string, returnUrl: string, istate: string): string {
  const p = new URLSearchParams({ provider, redirect: returnUrl, istate })
  return `${relayBase()}/api/oauth/start?${p.toString()}`
}

/** Exchange the sealed blob for the provider tokens (server-to-server). */
export async function relayClaim(blob: string): Promise<{ provider: string; tokens: any }> {
  const r = await fetch(`${relayBase()}/api/oauth/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ blob }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`relay claim ${r.status}: ${JSON.stringify(d).slice(0, 160)}`)
  return d
}

/** Persist tokens where each connector expects them. */
export async function saveProviderTokens(store: Store, provider: string, tokens: any): Promise<void> {
  const expires_at = Date.now() + (((Number(tokens?.expires_in) || 3600) - 60) * 1000)
  const t = {
    access_token: tokens?.access_token || '',
    refresh_token: tokens?.refresh_token || '',
    expires_at,
  }
  const TTL = 60 * 60 * 24 * 365
  if (provider === 'spotify') await store.putKv('spotify:oauth', JSON.stringify(t), TTL)
  else await store.putKv(`cloud:oauth:${provider}`, JSON.stringify(t), TTL) // google / microsoft
}

// ── CSRF state for the round-trip ──
export async function makeRelayState(store: Store): Promise<string> {
  const s = crypto.randomBytes(16).toString('hex')
  await store.putKv(`oauth:relaystate:${s}`, '1', 600).catch(() => {})
  return s
}
export async function consumeRelayState(store: Store, s: string): Promise<boolean> {
  if (!s) return false
  const ok = await store.getKv(`oauth:relaystate:${s}`).catch(() => null)
  if (ok) await store.delKv(`oauth:relaystate:${s}`).catch(() => {})
  return !!ok
}
