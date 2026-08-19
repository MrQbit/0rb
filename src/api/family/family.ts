/**
 * Family layer — the household as first-class users.
 *
 * Notes between members ("tell Sarah the package is in the garage") with
 * two delivery triggers: her next interaction with Orb (any surface), or
 * the moment her presence flips to home. A shared household calendar that
 * needs no external account. Announcements over the home's speakers.
 *
 * Identity comes from the session (ownerId = "user:<email>"); member
 * records live in the auth users db (roles, per-user Telegram chat ids,
 * optional HA person entity for presence links).
 */
import type { Store } from '../store/store.js'
import { getUsers, findUser, normalizeEmail, type AuthUser } from '../auth/otp.js'
import { log } from '../log.js'

const NOTES_KEY = 'family:notes'
const EVENTS_KEY = 'family:events'

export interface FamilyNote {
  id: string
  from: string
  to: string
  text: string
  created: number
  /** deliver on the recipient's next interaction, or when they arrive home */
  trigger: 'next' | 'home'
  delivered?: number
}

export interface FamilyEvent {
  id: string
  title: string
  /** ISO date YYYY-MM-DD */
  date: string
  time?: string
  who?: string
}

function rid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`
}

/** Email from a session ownerId ("user:a@b.c" → "a@b.c"). */
export function emailFromOwnerId(ownerId: string): string {
  return normalizeEmail(String(ownerId || '').replace(/^user:/, ''))
}

/** Resolve a human reference ("sarah", an email, a label) to a member. */
export async function resolveMember(store: Store, ref: string): Promise<AuthUser | null> {
  const q = String(ref || '').trim().toLowerCase()
  if (!q) return null
  const users = await getUsers(store)
  return (
    users.find(u => u.email === q) ??
    users.find(u => (u.label || '').toLowerCase() === q) ??
    users.find(u => u.email.split('@')[0] === q) ??
    users.find(u => (u.label || '').toLowerCase().includes(q) || u.email.startsWith(q)) ??
    null
  )
}

// ── notes ──────────────────────────────────────────────────────────────
export async function listNotes(store: Store): Promise<FamilyNote[]> {
  try { return JSON.parse((await store.getKv(NOTES_KEY)) || '[]') } catch { return [] }
}
async function saveNotes(store: Store, notes: FamilyNote[]): Promise<void> {
  // Delivered notes stay on the board for 3 days, then age out.
  const cutoff = Date.now() - 3 * 24 * 3600_000
  await store.putKv(NOTES_KEY, JSON.stringify(notes.filter(n => !n.delivered || n.delivered > cutoff)), 0)
}

export async function addNote(store: Store, from: string, to: string, text: string, trigger: 'next' | 'home'): Promise<FamilyNote> {
  const notes = await listNotes(store)
  const n: FamilyNote = { id: rid('fn'), from: normalizeEmail(from), to: normalizeEmail(to), text: text.slice(0, 500), created: Date.now(), trigger }
  notes.push(n)
  await saveNotes(store, notes)
  return n
}

/** Undelivered notes for a recipient+trigger; marks them delivered. */
export async function takePendingNotes(store: Store, email: string, trigger: 'next' | 'home'): Promise<FamilyNote[]> {
  const e = normalizeEmail(email)
  const notes = await listNotes(store)
  const due = notes.filter(n => n.to === e && n.trigger === trigger && !n.delivered)
  if (due.length) {
    for (const n of due) n.delivered = Date.now()
    await saveNotes(store, notes)
  }
  return due
}

/** Display name for a member email. */
export async function memberName(store: Store, email: string): Promise<string> {
  const u = await findUser(store, email)
  return u?.label || email.split('@')[0] || email
}

// ── per-user notification (Telegram per member) ────────────────────────
export async function notifyUser(store: Store, email: string, text: string): Promise<boolean> {
  const u = await findUser(store, email)
  const token = process.env.ORB2_TELEGRAM_BOT_TOKEN
  if (u?.telegram_chat_id && token) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: u.telegram_chat_id, text }),
      })
      log.info('family_notify_sent', { to: email })
      return true
    } catch (err) { log.warn('family_notify_failed', { to: email, error: (err as Error).message }) }
  }
  return false
}

/**
 * System-prompt context for a turn: who is talking (name + role), plus any
 * notes waiting on their next interaction (marked delivered here — the
 * model relays them at the start of its reply).
 */
export async function familyPromptExtra(store: Store, ownerId: string): Promise<string> {
  const email = emailFromOwnerId(ownerId)
  if (!email || !email.includes('@')) return ''
  try {
    const u = await findUser(store, email)
    if (!u) return ''
    const users = await getUsers(store)
    const idx = users.findIndex(x => x.email === u.email)
    const role = u.role ?? (idx === 0 ? 'owner' : 'member')
    let out = `\nCurrent user: ${u.label || email} <${email}> (household ${role}).`
    const due = await takePendingNotes(store, email, 'next')
    if (due.length) {
      const lines = await Promise.all(due.map(async n => `- from ${await memberName(store, n.from)}: "${n.text}"`))
      out += `\nFAMILY BOARD — deliver these waiting notes to them naturally at the START of your reply:\n${lines.join('\n')}`
    }
    return out
  } catch { return '' }
}

// ── shared household calendar ──────────────────────────────────────────
export async function listEvents(store: Store): Promise<FamilyEvent[]> {
  try {
    const all = JSON.parse((await store.getKv(EVENTS_KEY)) || '[]') as FamilyEvent[]
    const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10)
    return all.filter(e => e.date >= cutoff).sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''))
  } catch { return [] }
}
export async function addEvent(store: Store, ev: { title: string; date: string; time?: string; who?: string }): Promise<FamilyEvent | { error: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.date)) return { error: 'date must be YYYY-MM-DD' }
  if (ev.time && !/^\d{1,2}:\d{2}$/.test(ev.time)) return { error: 'time must be HH:MM' }
  const events = await listEvents(store)
  const e: FamilyEvent = { id: rid('fe'), title: String(ev.title).slice(0, 120), date: ev.date, time: ev.time, who: ev.who }
  events.push(e)
  await store.putKv(EVENTS_KEY, JSON.stringify(events), 0)
  return e
}
export async function removeEvent(store: Store, query: string): Promise<FamilyEvent | null> {
  const events = await listEvents(store)
  const q = query.toLowerCase()
  const idx = events.findIndex(e => e.id === query || e.title.toLowerCase().includes(q))
  if (idx < 0) return null
  const [gone] = events.splice(idx, 1)
  await store.putKv(EVENTS_KEY, JSON.stringify(events), 0)
  return gone!
}
