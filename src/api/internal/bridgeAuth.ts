/**
 * Worker bridge auth — short-lived HMAC tokens for the
 * RAK00N_INTERNAL_TOKEN that workers carry when they call back into
 * router-side APIs.
 *
 * Token shape (urlsafe base64): "<sessionId>.<turnId>.<expSeconds>.<sigHex>"
 *
 * sig = HMAC-SHA256(secret, `${sessionId}.${turnId}.${expSeconds}`)
 *
 * The router validates by recomputing the HMAC with its own secret and
 * comparing in constant time. Tokens are scoped to a single sessionId
 * + turnId pair so a leaked token can only act on the work it was
 * issued for, and only until expiry (default 30 min, well past the
 * worker's wall-clock deadline).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const DEFAULT_TTL_SECONDS = 30 * 60

function getSecret(): string {
  // RAK00N_INTERNAL_HMAC_SECRET is mounted from a Helm-managed Secret in
  // production. In dev (no env), generate a per-process random one
  // -- workers always run in the same cluster pod so the router and
  // workers will agree only when the secret is shared. We never log
  // the secret.
  const explicit = process.env.RAK00N_INTERNAL_HMAC_SECRET
  if (explicit && explicit.length >= 16) return explicit
  // Fallback: derive from REDIS_URL so router + workers in the same
  // cluster share a stable secret for dev. Not for prod.
  const red = process.env.REDIS_URL || 'no-redis'
  return `dev-bridge-${red}`
}

export function issueBridgeToken(
  sessionId: string,
  turnId: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds
  const payload = `${sessionId}.${turnId}.${exp}`
  const sig = createHmac('sha256', getSecret()).update(payload).digest('hex')
  return `${payload}.${sig}`
}

export type BridgeClaim = {
  sessionId: string
  turnId: string
  exp: number
}

export function verifyBridgeToken(token: string): BridgeClaim | null {
  if (typeof token !== 'string' || token.length < 8) return null
  const parts = token.split('.')
  if (parts.length !== 4) return null
  const [sessionId, turnId, expStr, sigHex] = parts
  const exp = parseInt(expStr, 10)
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) return null
  const expected = createHmac('sha256', getSecret())
    .update(`${sessionId}.${turnId}.${exp}`)
    .digest('hex')
  try {
    const a = Buffer.from(expected, 'hex')
    const b = Buffer.from(sigHex, 'hex')
    if (a.length !== b.length) return null
    if (!timingSafeEqual(a, b)) return null
  } catch {
    return null
  }
  return { sessionId, turnId, exp }
}

/** Returns a random 32-hex-char token used as an idempotency key in tools. */
export function freshIdempotencyKey(): string {
  return randomBytes(16).toString('hex')
}
