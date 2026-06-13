/**
 * Push relay (Firebase Cloud Messaging).
 *
 * The 0rb apps register their device push token here; the server sends 0rb's
 * proactive nudges ("garage open since 2pm") to them via FCM HTTP v1, so the
 * phone gets a lock-screen notification even when the app is closed. iOS goes
 * through FCM too (Firebase fronts APNs), so one path serves both.
 *
 * Config (off until set):
 *   RAK00N_FCM_PROJECT_ID         Firebase project id
 *   RAK00N_FCM_SERVICE_ACCOUNT    service-account JSON (inline) or a file path
 *
 * Tokens live in the store under push:fcm_tokens. Best-effort throughout —
 * never throws into the caller (the proactive watcher).
 */
import type { Store } from '../store/store.js'
import { log } from '../log.js'

const TOKENS_KEY = 'push:fcm_tokens'
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'

export function pushEnabled(): boolean {
  return !!(process.env.RAK00N_FCM_PROJECT_ID && process.env.RAK00N_FCM_SERVICE_ACCOUNT)
}

// ─────────────────────────── token registry ───────────────────────────

export async function getTokens(store: Store): Promise<string[]> {
  try {
    const raw = await store.getKv(TOKENS_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch { return [] }
}

async function saveTokens(store: Store, tokens: string[]): Promise<void> {
  try { await store.putKv(TOKENS_KEY, JSON.stringify([...new Set(tokens)]), 60 * 60 * 24 * 3650) } catch { /* best effort */ }
}

export async function registerToken(store: Store, token: string): Promise<void> {
  if (!token) return
  const tokens = await getTokens(store)
  if (!tokens.includes(token)) { tokens.push(token); await saveTokens(store, tokens) }
}

export async function unregisterToken(store: Store, token: string): Promise<void> {
  const tokens = (await getTokens(store)).filter(t => t !== token)
  await saveTokens(store, tokens)
}

// ─────────────────────────── sending ───────────────────────────

let cachedToken: { value: string; exp: number } | null = null

async function accessToken(): Promise<string | null> {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.value
  try {
    const { GoogleAuth } = await import('google-auth-library')
    const sa = (process.env.RAK00N_FCM_SERVICE_ACCOUNT || '').trim()
    const credentials = sa.startsWith('{') ? JSON.parse(sa) : undefined
    const auth = new GoogleAuth({
      ...(credentials ? { credentials } : { keyFile: sa }),
      scopes: [SCOPE],
    })
    const client = await auth.getClient()
    const t = await client.getAccessToken()
    if (!t?.token) return null
    cachedToken = { value: t.token, exp: Date.now() + 50 * 60_000 } // ~1h tokens; refresh at 50m
    return t.token
  } catch (err) {
    log.warn('fcm_token_failed', { error: (err as Error).message })
    return null
  }
}

/**
 * Send a notification to every registered device. No-op (logged) when push
 * isn't configured. Prunes tokens FCM reports as gone.
 */
export async function sendPush(store: Store, title: string, body: string, data: Record<string, string> = {}): Promise<void> {
  if (!pushEnabled()) { log.info('push_skipped', { reason: 'not configured', title }); return }
  const tokens = await getTokens(store)
  if (!tokens.length) return
  const bearer = await accessToken()
  if (!bearer) return
  const project = process.env.RAK00N_FCM_PROJECT_ID
  const url = `https://fcm.googleapis.com/v1/projects/${project}/messages:send`
  const dead: string[] = []
  for (const token of tokens) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message: { token, notification: { title, body }, data } }),
      })
      if (res.status === 404 || res.status === 403) dead.push(token) // unregistered/expired
    } catch (err) {
      log.warn('fcm_send_failed', { error: (err as Error).message })
    }
  }
  if (dead.length) await saveTokens(store, tokens.filter(t => !dead.includes(t)))
  log.info('push_sent', { to: tokens.length - dead.length, pruned: dead.length, title })
}
