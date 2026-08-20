/**
 * The claim ceremony (v0.2 S2). A brand-new orb belongs to whoever is
 * standing in front of it: while NO owner account exists, the console shows
 * a QR encoding orb2-claim://<host>/<code> — scanning it (or typing the
 * code) creates the owner account and a signed-in session in one step.
 * Physical presence is the trust anchor, so the window closes forever the
 * moment an owner exists; after that, enrollment is invitation + emailed
 * OTP. Codes live 10 minutes and are single-use.
 */
import { randomBytes } from 'node:crypto'
import type { Store } from '../store/store.js'
import { getUsers, addUser, normalizeEmail } from './otp.js'
import { signSession } from './session.js'

const KEY = 'claim:code'
const TTL_MS = 10 * 60_000
// no 0/O/1/I — the code may be typed from across the room
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export async function claimAvailable(store: Store): Promise<boolean> {
  return (await getUsers(store)).length === 0
}

/** The active claim code, minting or rotating as needed. Null once owned. */
export async function currentClaim(store: Store, host: string): Promise<{ code: string; expires_at: number; uri: string } | null> {
  if (!(await claimAvailable(store))) {
    await store.delKv(KEY).catch(() => { /* best effort */ })
    return null
  }
  let cur: { code: string; exp: number } | null = null
  try { cur = JSON.parse((await store.getKv(KEY)) || 'null') } catch { /* remint */ }
  if (!cur || cur.exp < Date.now()) {
    const raw = randomBytes(8)
    const code = Array.from(raw, b => ALPHABET[b % ALPHABET.length]).join('')
    cur = { code, exp: Date.now() + TTL_MS }
    await store.putKv(KEY, JSON.stringify(cur), 0)
  }
  return { code: cur.code, expires_at: cur.exp, uri: `orb2-claim://${host}/${cur.code}` }
}

/** Redeem: single-use, creates THE owner, returns a session token. */
export async function redeemClaim(store: Store, codeIn: string, emailRaw: string): Promise<{ ok: boolean; token?: string; error?: string }> {
  if (!(await claimAvailable(store))) return { ok: false, error: 'already claimed' }
  const email = normalizeEmail(emailRaw)
  if (!email || !email.includes('@')) return { ok: false, error: 'valid email required' }
  let cur: { code: string; exp: number } | null = null
  try { cur = JSON.parse((await store.getKv(KEY)) || 'null') } catch { /* fall through */ }
  if (!cur || cur.exp < Date.now()) return { ok: false, error: 'code expired' }
  if (cur.code !== String(codeIn || '').trim().toUpperCase()) return { ok: false, error: 'wrong code' }
  // burn before minting — a race must fail closed, not mint two owners
  await store.putKv(KEY, JSON.stringify({ code: '', exp: 0 }), 0)
  await addUser(store, { email, role: 'owner', label: 'Owner' })
  return { ok: true, token: signSession(email) }
}
