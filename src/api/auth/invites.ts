/**
 * Household invitations (Profiles v2). The owner mints a link (or QR);
 * whoever opens it enters their email, becomes a member, and gets their
 * sign-in code — no owner-side typing of addresses. Tokens are single-use
 * and expire in 7 days.
 */
import { randomBytes } from 'node:crypto'
import type { Store } from '../store/store.js'
import { addUser, findUser, normalizeEmail } from './otp.js'

const KEY = (t: string) => `invite:${t}`
const INDEX = 'invite:index'
const TTL_S = 7 * 24 * 3600

export interface Invite { token: string; invited_by: string; note?: string; created_at: number; expires_at: number }

async function index(store: Store): Promise<string[]> {
  try { return JSON.parse((await store.getKv(INDEX)) || '[]') } catch { return [] }
}

export async function createInvite(store: Store, invitedBy: string, note?: string): Promise<Invite> {
  const token = randomBytes(12).toString('base64url')
  const inv: Invite = { token, invited_by: invitedBy, note: note?.slice(0, 60), created_at: Date.now(), expires_at: Date.now() + TTL_S * 1000 }
  await store.putKv(KEY(token), JSON.stringify(inv), TTL_S)
  await store.putKv(INDEX, JSON.stringify([...(await index(store)), token]), 0)
  return inv
}

export async function listInvites(store: Store): Promise<Invite[]> {
  const out: Invite[] = []
  const live: string[] = []
  for (const t of await index(store)) {
    try {
      const raw = await store.getKv(KEY(t))
      if (!raw) continue
      const inv = JSON.parse(raw)
      if (inv.expires_at > Date.now()) { out.push(inv); live.push(t) }
    } catch { /* drop */ }
  }
  await store.putKv(INDEX, JSON.stringify(live), 0).catch(() => {})
  return out
}

export async function revokeInvite(store: Store, token: string): Promise<void> {
  await store.delKv(KEY(token)).catch(() => {})
}

export async function readInvite(store: Store, token: string): Promise<Invite | null> {
  try {
    const inv = JSON.parse((await store.getKv(KEY(token))) || 'null')
    return inv && inv.expires_at > Date.now() ? inv : null
  } catch { return null }
}

/** Accept: burn the token, create the member. Sign-in still proves the email via OTP. */
export async function acceptInvite(store: Store, token: string, emailRaw: string, firstName?: string): Promise<{ ok: boolean; error?: string }> {
  const inv = await readInvite(store, token)
  if (!inv) return { ok: false, error: 'This invitation is no longer valid — ask for a fresh one.' }
  const email = normalizeEmail(emailRaw)
  if (!email.includes('@')) return { ok: false, error: 'a valid email is required' }
  await store.delKv(KEY(token)).catch(() => {})   // single-use, burn first
  if (!(await findUser(store, email))) {
    await addUser(store, { email, role: 'member', label: firstName?.trim() || undefined })
    if (firstName?.trim()) {
      const { updateUser } = await import('./otp.js')
      await updateUser(store, email, { first_name: firstName.trim() })
    }
  }
  return { ok: true }
}
