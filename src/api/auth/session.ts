/**
 * Username/password login + signed session tokens for the single-user
 * orb2 console, channels, and iOS app.
 *
 * Design (no new dependencies — all from node:crypto):
 *   - Passwords are hashed with scrypt: `scrypt$N$salt$hash` (hex). We
 *     never store plaintext; verification is constant-time.
 *   - A session is a stateless signed token:
 *         orb2sess_<base64url(payload)>.<base64url(hmac)>
 *     payload = { u: username, iat, exp }. HMAC-SHA256 over the payload
 *     with ORB2_AUTH_SECRET. Stateless = no server store needed; the same
 *     token works as an HttpOnly cookie (browser) AND a Bearer header
 *     (iOS app / channels). Revoke-all = rotate ORB2_AUTH_SECRET.
 *
 * Credentials resolve from the store (so they're changeable via the
 * console) and fall back to env for first-boot bootstrap:
 *   ORB2_AUTH_USER         bootstrap username
 *   ORB2_AUTH_PASS_HASH    bootstrap scrypt hash (use scripts/set-password)
 *   ORB2_AUTH_SECRET       HMAC signing secret (required when auth is on)
 */
import { scryptSync, randomBytes, createHmac, timingSafeEqual } from 'node:crypto'
import type { Store } from '../store/store.js'

export const SESSION_COOKIE = 'orb2_session'
const SESSION_PREFIX = 'orb2sess_'
const SCRYPT_N = 16384
const SCRYPT_KEYLEN = 32
const DEFAULT_TTL_S = 60 * 60 * 24 * 30 // 30 days

export type SessionPayload = { u: string; iat: number; exp: number }
export type Credentials = { username: string; passHash: string }

// ─────────────────────────── passwords ───────────────────────────

/**
 * Hash a plaintext password → `scrypt.N.salt.hash` (all hex).
 * Dot-delimited (not `$`) so the hash survives docker-compose / shell
 * `$`-interpolation when carried through env vars.
 */
export function hashPassword(plaintext: string): string {
  const salt = randomBytes(16)
  const dk = scryptSync(plaintext, salt, SCRYPT_KEYLEN, { N: SCRYPT_N })
  return `scrypt.${SCRYPT_N}.${salt.toString('hex')}.${dk.toString('hex')}`
}

/** Constant-time verify of a plaintext password against a stored hash. */
export function verifyPassword(plaintext: string, stored: string): boolean {
  try {
    // Accept both the new dot form and any legacy `$` form.
    const [scheme, nStr, saltHex, hashHex] = stored.split(/[.$]/)
    if (scheme !== 'scrypt') return false
    const N = Number(nStr)
    const salt = Buffer.from(saltHex, 'hex')
    const expected = Buffer.from(hashHex, 'hex')
    const dk = scryptSync(plaintext, salt, expected.length, { N })
    return dk.length === expected.length && timingSafeEqual(dk, expected)
  } catch {
    return false
  }
}

// ──────────────────────────── sessions ───────────────────────────

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url')
}

function secret(): string {
  return process.env.ORB2_AUTH_SECRET || ''
}

/**
 * Guarantee a session-signing secret exists. Without ORB2_AUTH_SECRET,
 * verifySession() rejects every token — so on first boot we load a persisted
 * secret or generate + persist one. Must run before any login/claim.
 */
export async function ensureSessionSecret(store: Store): Promise<void> {
  if (process.env.ORB2_AUTH_SECRET) return
  const KEY = 'auth:session_secret'
  try {
    const existing = await store.getKv(KEY)
    if (existing) { process.env.ORB2_AUTH_SECRET = existing; return }
  } catch { /* fall through to generate */ }
  const generated = randomBytes(32).toString('hex')
  process.env.ORB2_AUTH_SECRET = generated
  try { await store.putKv(KEY, generated, 60 * 60 * 24 * 3650) } catch { /* best effort */ }
}

/** Whether username/password auth is switched on. */
export function authEnabled(): boolean {
  return (process.env.ORB2_API_AUTH_REQUIRED ?? '0') === '1'
}

/** Mint a signed session token for `username`. */
export function signSession(username: string, ttlSeconds = DEFAULT_TTL_S): string {
  const now = Math.floor(Date.now() / 1000)
  const payload: SessionPayload = { u: username, iat: now, exp: now + ttlSeconds }
  const body = b64url(JSON.stringify(payload))
  const mac = createHmac('sha256', secret()).update(body).digest()
  return `${SESSION_PREFIX}${body}.${b64url(mac)}`
}

/** Verify a session token; returns its payload or null. */
export function verifySession(token: string): SessionPayload | null {
  if (!token || !token.startsWith(SESSION_PREFIX) || !secret()) return null
  const raw = token.slice(SESSION_PREFIX.length)
  const dot = raw.lastIndexOf('.')
  if (dot < 0) return null
  const body = raw.slice(0, dot)
  const sig = Buffer.from(raw.slice(dot + 1), 'base64url')
  const expected = createHmac('sha256', secret()).update(body).digest()
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as SessionPayload
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}

export function isSessionToken(s: string | null | undefined): boolean {
  return typeof s === 'string' && s.startsWith(SESSION_PREFIX)
}

// ───────────────────────────── cookies ───────────────────────────

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

/** Set-Cookie value for a session (HttpOnly, SameSite=Lax, secure-aware). */
export function sessionCookie(token: string, ttlSeconds = DEFAULT_TTL_S): string {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${ttlSeconds}`,
  ]
  if ((process.env.ORB2_AUTH_COOKIE_SECURE ?? '0') === '1') attrs.push('Secure')
  return attrs.join('; ')
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

// ─────────────────────────── credentials ─────────────────────────

const CRED_KEY = 'auth:credentials'
const CRED_TTL_S = 60 * 60 * 24 * 3650 // ~10y; credentials don't expire

/** Resolve the configured credentials: store first, then env bootstrap. */
export async function getCredentials(store: Store): Promise<Credentials | null> {
  try {
    const raw = await store.getKv(CRED_KEY)
    if (raw) return JSON.parse(raw) as Credentials
  } catch { /* fall through to env bootstrap */ }
  const username = process.env.ORB2_AUTH_USER
  const passHash = process.env.ORB2_AUTH_PASS_HASH
  if (username && passHash) return { username, passHash }
  return null
}

/** Persist new credentials (console "change password"). */
export async function setCredentials(store: Store, creds: Credentials): Promise<void> {
  await store.putKv(CRED_KEY, JSON.stringify(creds), CRED_TTL_S)
}

/** Validate a login attempt; returns the username on success. */
export async function checkLogin(
  store: Store,
  username: string,
  password: string,
): Promise<string | null> {
  const creds = await getCredentials(store)
  if (!creds) return null
  if (username !== creds.username) return null
  return verifyPassword(password, creds.passHash) ? creds.username : null
}
