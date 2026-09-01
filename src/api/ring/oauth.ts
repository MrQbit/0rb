/**
 * Ring OAuth for two-way audio (SPEC §16.4).
 *
 * go2rtc's native `ring:` source opens its own WebRTC session with Ring —
 * the only rail that reaches the camera's SPEAKER (ring-mqtt's external
 * RTSP is one-way). It needs a refresh token, and it must be a SEPARATE
 * token from ring-mqtt's: Ring rotates refresh tokens, and two clients
 * sharing one race each other into invalidation.
 *
 * This is the same password+2FA exchange ring-mqtt's own authenticator
 * performs, against the user's own account. Credentials pass through;
 * only the refresh token is stored (kv ring:twoway:token).
 */
import { createHash } from 'node:crypto'
import type { Store } from '../store/store.js'

const TOKEN_KEY = 'ring:twoway:token'
const OAUTH_URL = 'https://oauth.ring.com/oauth/token'

/** Stable per-install hardware id (Ring tracks 2FA trust per device). */
function hardwareId(): string {
  const h = createHash('sha256').update('orb2-ring-twoway:' + (process.env.ORB2_AUTH_SECRET || 'orb2')).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

export async function getTwowayToken(store: Store): Promise<string | null> {
  return (await store.getKv(TOKEN_KEY).catch(() => null)) || null
}

export async function clearTwowayToken(store: Store): Promise<void> {
  await store.delKv(TOKEN_KEY).catch(() => {})
}

export async function ringOauth(
  store: Store,
  o: { email: string; password: string; code?: string },
): Promise<{ ok: boolean; requires2fa?: boolean; prompt?: string; error?: string }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    '2fa-support': 'true',
    hardware_id: hardwareId(),
    'user-agent': 'android:com.ringapp',
  }
  if (o.code) headers['2fa-code'] = o.code.trim()
  let r: Response
  try {
    r = await fetch(OAUTH_URL, {
      method: 'POST', headers,
      body: JSON.stringify({
        client_id: 'ring_official_android', scope: 'client', grant_type: 'password',
        username: o.email, password: o.password,
      }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (e) {
    return { ok: false, error: `Ring unreachable — ${(e as Error).message}` }
  }
  const j = await r.json().catch(() => ({})) as any
  if (r.status === 412 || j?.tsv_state) {
    return { ok: false, requires2fa: true, prompt: j?.phone ? `code sent to ${j.phone}` : 'enter the code Ring sent you' }
  }
  if (!r.ok || !j?.refresh_token) {
    return { ok: false, error: j?.error_description || j?.error || `Ring auth failed (${r.status})` }
  }
  await store.putKv(TOKEN_KEY, String(j.refresh_token), 60 * 60 * 24 * 365 * 5)
  return { ok: true }
}

/**
 * Ensure the two-way stream exists in our go2rtc: `ring_talk`, backed by the
 * native ring: source for the given camera. Idempotent; cheap enough to call
 * from status checks (go2rtc forgets runtime streams on restart).
 */
export async function ensureTwowayStream(store: Store, go2rtcBase: string, deviceId: string): Promise<boolean> {
  const token = await getTwowayToken(store)
  if (!token || !deviceId) return false
  const src = `ring:?refresh_token=${encodeURIComponent(token)}&device_id=${encodeURIComponent(deviceId)}`
  try {
    const r = await fetch(`${go2rtcBase}/api/streams?name=ring_talk&src=${encodeURIComponent(src)}`, {
      method: 'PUT', signal: AbortSignal.timeout(5000),
    })
    return r.ok
  } catch { return false }
}
