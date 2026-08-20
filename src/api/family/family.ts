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
  /** 'yearly' = birthdays/anniversaries — rolls to the next occurrence */
  repeat?: 'yearly'
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
  // Profiles v2: tell the agent who this is and which apps are off.
  let profileNote = ''
  try {
    const email = ownerId.replace(/^user:/, '')
    if (email.includes('@')) {
      const { findUser, displayName } = await import('../auth/otp.js')
      const u = await findUser(store, email)
      if (u) {
        const { APP_GROUPS } = await import('../auth/appGroups.js')
        const off = (u.disabled_apps || []).map(a => APP_GROUPS[a]?.label || a)
        profileNote = `\nYou are talking with ${displayName(u)}${u.role === 'owner' ? ' (household owner)' : ''}.`
          + (off.length ? `\nApps turned OFF for this member by the owner: ${off.join(', ')}. If they ask for one of these, do NOT attempt it — explain kindly that it's switched off for their profile and the owner can enable it in Settings → Users.` : '')
      }
    }
  } catch { /* optional */ }
  const email = emailFromOwnerId(ownerId)
  if (!email || !email.includes('@')) return ''
  try {
    const u = await findUser(store, email)
    if (!u) return ''
    const users = await getUsers(store)
    const idx = users.findIndex(x => x.email === u.email)
    const role = u.role ?? (idx === 0 ? 'owner' : 'member')
    let out = `\nCurrent user: ${u.label || email} <${email}> (household ${role}).`
    out += profileNote
    const prefs = await getPrefs(store, email)
    const pk = Object.entries(prefs)
    if (pk.length) out += `\nTheir preferences: ${pk.map(([k, v]) => `${k}: ${v}`).join('; ')}.`
    // Personal memory (v0.2 §4): this member's own memory file rides into
    // their turns; the agent maintains it like MEMORY.md, scoped to them.
    try {
      const { isAutoMemoryEnabled, getAutoMemPath } = await import('../memory/memPath.js')
      if (isAutoMemoryEnabled()) {
        const { readFile } = await import('node:fs/promises')
        const slug = email.split('@')[0]!.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
        const memberPath = `${getAutoMemPath()}/members/${slug}.md`
        const content = await readFile(memberPath, 'utf8').catch(() => '')
        if (content.trim()) {
          out += `\nPERSONAL MEMORY for this user (their file: ${memberPath} — keep it updated with Write/Edit; personal facts go THERE, household facts in MEMORY.md):\n${content.slice(0, 1600)}`
        } else {
          out += `\nPERSONAL MEMORY: none saved yet for this user. When you learn a durable personal fact about them (preferences, routines, people), save it to ${memberPath} (create the file; same format as MEMORY.md). Household facts stay in MEMORY.md.`
        }
      }
    } catch { /* memory optional */ }
    const due = await takePendingNotes(store, email, 'next')
    if (due.length) {
      const lines = await Promise.all(due.map(async n => `- from ${await memberName(store, n.from)}: "${n.text}"`))
      out += `\nFAMILY BOARD — deliver these waiting notes to them naturally at the START of your reply:\n${lines.join('\n')}`
    }
    return out
  } catch { return '' }
}

// ── shared household calendar ──────────────────────────────────────────
/** Pure: roll a yearly event forward to its next occurrence on/after `from`. */
export function nextOccurrence(dateISO: string, from: string): string {
  const [, m, d] = dateISO.split('-')
  const fromY = Number(from.slice(0, 4))
  const thisYear = `${fromY}-${m}-${d}`
  return thisYear >= from ? thisYear : `${fromY + 1}-${m}-${d}`
}

export async function listEvents(store: Store): Promise<FamilyEvent[]> {
  try {
    const all = JSON.parse((await store.getKv(EVENTS_KEY)) || '[]') as FamilyEvent[]
    const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10)
    const materialized = all.map(e => e.repeat === 'yearly' ? { ...e, date: nextOccurrence(e.date, cutoff) } : e)
    return materialized.filter(e => e.date >= cutoff).sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''))
  } catch { return [] }
}
export async function addEvent(store: Store, ev: { title: string; date: string; time?: string; who?: string; repeat?: 'yearly' }): Promise<FamilyEvent | { error: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.date)) return { error: 'date must be YYYY-MM-DD' }
  if (ev.time && !/^\d{1,2}:\d{2}$/.test(ev.time)) return { error: 'time must be HH:MM' }
  let events: FamilyEvent[] = []
  try { events = JSON.parse((await store.getKv(EVENTS_KEY)) || '[]') } catch { /* empty */ }
  const e: FamilyEvent = { id: rid('fe'), title: String(ev.title).slice(0, 120), date: ev.date, time: ev.time, who: ev.who, repeat: ev.repeat === 'yearly' ? 'yearly' : undefined }
  events.push(e)
  await store.putKv(EVENTS_KEY, JSON.stringify(events), 0)
  return e
}
export async function removeEvent(store: Store, query: string): Promise<FamilyEvent | null> {
  let events: FamilyEvent[] = []
  try { events = JSON.parse((await store.getKv(EVENTS_KEY)) || '[]') } catch { /* empty */ }
  const q = query.toLowerCase()
  const idx = events.findIndex(e => e.id === query || e.title.toLowerCase().includes(q))
  if (idx < 0) return null
  const [gone] = events.splice(idx, 1)
  await store.putKv(EVENTS_KEY, JSON.stringify(events), 0)
  return gone!
}

// ── per-person preferences (round 2: settings isolation, the human kind) ─
// Free-form personal preferences the agent honours per member ("keep replies
// short", "my coffee is a flat white", "call me Max"). Injected into the
// system prompt for that member's turns only.
const PREFS_PREFIX = 'family:prefs:'

export async function getPrefs(store: Store, email: string): Promise<Record<string, string>> {
  try { return JSON.parse((await store.getKv(PREFS_PREFIX + normalizeEmail(email))) || '{}') } catch { return {} }
}
export async function setPref(store: Store, email: string, key: string, value: string): Promise<void> {
  const prefs = await getPrefs(store, email)
  const k = key.trim().slice(0, 40)
  if (!k) return
  if (value.trim()) prefs[k] = value.trim().slice(0, 200)
  else delete prefs[k]
  await store.putKv(PREFS_PREFIX + normalizeEmail(email), JSON.stringify(prefs), 0)
}

// ── chore rota ─────────────────────────────────────────────────────────
const CHORES_KEY = 'family:chores'

export interface Chore {
  id: string
  title: string
  who: string
  /** optional weekday 0-6 (Sun-Sat) it recurs on; one-off when absent */
  day?: number
  done?: number
}

export async function listChores(store: Store): Promise<Chore[]> {
  try {
    const all = JSON.parse((await store.getKv(CHORES_KEY)) || '[]') as Chore[]
    // Recurring chores reset when their day comes around again.
    const today = new Date().getDay()
    let changed = false
    for (const c of all) {
      if (c.day !== undefined && c.done && c.day === today && Date.now() - c.done > 24 * 3600_000) { c.done = undefined; changed = true }
    }
    if (changed) await store.putKv(CHORES_KEY, JSON.stringify(all), 0)
    return all
  } catch { return [] }
}
export async function addChore(store: Store, title: string, who: string, day?: number): Promise<Chore> {
  const chores = await listChores(store)
  const c: Chore = { id: rid('ch'), title: title.slice(0, 120), who: normalizeEmail(who), day }
  chores.push(c)
  await store.putKv(CHORES_KEY, JSON.stringify(chores), 0)
  return c
}
export async function completeChore(store: Store, query: string): Promise<Chore | null> {
  const chores = await listChores(store)
  const q = query.toLowerCase()
  const c = chores.find(x => !x.done && (x.id === query || x.title.toLowerCase().includes(q)))
  if (!c) return null
  c.done = Date.now()
  await store.putKv(CHORES_KEY, JSON.stringify(chores.filter(x => x.day !== undefined || !x.done || Date.now() - x.done! < 7 * 24 * 3600_000)), 0)
  return c
}

// ── care routines: recurring time-of-day reminders ─────────────────────
// Meds at 08:00 daily, feed the cat 07:00+19:00, water plants Sundays.
// The proactive tick fires them; delivery goes to the assigned member.
const ROUTINES_KEY = 'family:routines'

export interface Routine {
  id: string
  label: string
  /** HH:MM 24h */
  at: string
  /** weekdays 0-6 (Sun-Sat); absent = every day */
  days?: number[]
  to: string
  last_fired?: string  // YYYY-MM-DD of last delivery
}

export async function listRoutines(store: Store): Promise<Routine[]> {
  try { return JSON.parse((await store.getKv(ROUTINES_KEY)) || '[]') } catch { return [] }
}
export async function addRoutine(store: Store, r: { label: string; at: string; days?: number[]; to: string }): Promise<Routine | { error: string }> {
  if (!/^\d{1,2}:\d{2}$/.test(r.at)) return { error: "at must be 'HH:MM'" }
  if (r.days && (!Array.isArray(r.days) || r.days.some(d => d < 0 || d > 6))) return { error: 'days must be 0-6' }
  const routines = await listRoutines(store)
  const routine: Routine = { id: rid('rt'), label: r.label.slice(0, 120), at: r.at, days: r.days?.length ? r.days : undefined, to: normalizeEmail(r.to) }
  routines.push(routine)
  await store.putKv(ROUTINES_KEY, JSON.stringify(routines), 0)
  return routine
}
export async function removeRoutine(store: Store, query: string): Promise<Routine | null> {
  const routines = await listRoutines(store)
  const q = query.toLowerCase()
  const idx = routines.findIndex(r => r.id === query || r.label.toLowerCase().includes(q))
  if (idx < 0) return null
  const [gone] = routines.splice(idx, 1)
  await store.putKv(ROUTINES_KEY, JSON.stringify(routines), 0)
  return gone!
}

/** Pure: which routines are due at `now` (and not yet fired today). */
export function dueRoutines(routines: Routine[], now: Date): Routine[] {
  const today = now.toISOString().slice(0, 10)
  const day = now.getDay()
  const mins = now.getHours() * 60 + now.getMinutes()
  return routines.filter(r => {
    if (r.last_fired === today) return false
    if (r.days && !r.days.includes(day)) return false
    const [h, m] = r.at.split(':').map(Number)
    return mins >= h! * 60 + m!
  })
}

/** Fire due routines: notify each assignee, mark fired. Returns fired list. */
export async function fireDueRoutines(store: Store, fallbackNotify: (t: string) => Promise<void>): Promise<Routine[]> {
  const routines = await listRoutines(store)
  const due = dueRoutines(routines, new Date())
  if (!due.length) return []
  const today = new Date().toISOString().slice(0, 10)
  for (const r of due) {
    r.last_fired = today
    const text = `🔔 ${r.label}`
    if (!(await notifyUser(store, r.to, text))) await fallbackNotify(`${text} (for ${await memberName(store, r.to)})`)
  }
  await store.putKv(ROUTINES_KEY, JSON.stringify(routines), 0)
  return due
}
