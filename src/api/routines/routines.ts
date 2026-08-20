/**
 * Routines (v0.2 §9): user-visible scheduled agents. "Every Sunday at 5pm,
 * plan the week's meals and put them on the family board" becomes a durable
 * object the member can see, pause, and delete. Each run is a normal agent
 * turn under the owner's identity (their tools, their memory scope, their
 * consent policy — confirm-class actions still raise approval cards), and
 * every run leaves a receipt.
 *
 * Caps (spec blocker #7): one concurrent run, 20 runs/member/day,
 * auto-pause after 3 consecutive failures.
 */
import type { Store } from '../store/store.js'
import { log } from '../log.js'

export interface Routine {
  id: string
  owner: string             // member email
  instruction: string
  schedule: { kind: 'daily'; at: string }            // "HH:MM"
    | { kind: 'weekly'; day: number; at: string }    // 0=Sun
    | { kind: 'interval'; minutes: number }
  enabled: boolean
  createdAt: number
  lastRun?: number
  lastResult?: string
  failures: number
  runsToday?: { date: string; count: number }
}

const KEY = 'routines:all'
const MAX_PER_DAY = 20
const AUTO_PAUSE_FAILURES = 3
let running = false

async function load(store: Store): Promise<Routine[]> {
  try { return JSON.parse((await store.getKv(KEY)) || '[]') } catch { return [] }
}
async function save(store: Store, list: Routine[]): Promise<void> {
  await store.putKv(KEY, JSON.stringify(list), 0)
}

export async function listRoutines(store: Store, owner?: string): Promise<Routine[]> {
  const all = await load(store)
  return owner ? all.filter(r => r.owner === owner) : all
}

export async function addRoutine(store: Store, owner: string, instruction: string, schedule: Routine['schedule']): Promise<Routine> {
  const all = await load(store)
  const r: Routine = {
    id: `rt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    owner, instruction, schedule, enabled: true, createdAt: Date.now(), failures: 0,
  }
  all.push(r)
  await save(store, all)
  return r
}

export async function setRoutineEnabled(store: Store, id: string, enabled: boolean): Promise<boolean> {
  const all = await load(store)
  const r = all.find(x => x.id === id)
  if (!r) return false
  r.enabled = enabled
  if (enabled) r.failures = 0
  await save(store, all)
  return true
}

export async function removeRoutine(store: Store, id: string): Promise<boolean> {
  const all = await load(store)
  const next = all.filter(x => x.id !== id)
  if (next.length === all.length) return false
  await save(store, next)
  return true
}

/** Is this routine due at `now`, given when it last ran? */
export function isDue(r: Routine, now = new Date()): boolean {
  if (!r.enabled) return false
  const last = r.lastRun ?? 0
  if (r.schedule.kind === 'interval') {
    return Date.now() - last >= r.schedule.minutes * 60_000
  }
  const [h, m] = r.schedule.at.split(':').map(Number)
  const due = new Date(now)
  due.setHours(h || 0, m || 0, 0, 0)
  if (r.schedule.kind === 'weekly' && now.getDay() !== r.schedule.day) return false
  // Due once: after the scheduled minute, and not already run since it.
  return now.getTime() >= due.getTime() && last < due.getTime()
}

/** One scheduler tick: run at most ONE due routine (concurrency cap = 1). */
export async function tickRoutines(store: Store, now = new Date()): Promise<void> {
  if (running) return
  const all = await load(store)
  const due = all.find(r => isDue(r, now))
  if (!due) return
  const today = now.toISOString().slice(0, 10)
  const rt = due.runsToday?.date === today ? due.runsToday : { date: today, count: 0 }
  if (rt.count >= MAX_PER_DAY) return
  running = true
  due.lastRun = Date.now()
  due.runsToday = { date: today, count: rt.count + 1 }
  await save(store, all)
  try {
    const { runChannelTurn } = await import('../channels/runtime.js')
    const reply = await runChannelTurn({
      text: `[ROUTINE — scheduled by ${due.owner}; act, don't ask] ${due.instruction}\n` +
        `Deliver results as widgets and/or a Family note; keep any spoken-style summary to two sentences.`,
      sessionId: `routine:${due.id}`,
      ownerId: `user:${due.owner}`,
      store,
      channel: 'chat',
    } as any)
    due.failures = 0
    due.lastResult = String(reply || '').slice(0, 300)
    const { recordReceipt } = await import('../policy/policy.js')
    await recordReceipt(store, {
      user: due.owner, tool: 'Routine', key: `routine:${due.id}`,
      summary: `Routine ran: “${due.instruction.slice(0, 60)}”`,
    })
    log.info('routine_ran', { id: due.id, owner: due.owner })
  } catch (e) {
    due.failures += 1
    due.lastResult = `failed: ${(e as Error).message.slice(0, 200)}`
    if (due.failures >= AUTO_PAUSE_FAILURES) {
      due.enabled = false
      const { notifyOwner } = await import('../home/proactive.js')
      await notifyOwner(`I paused the routine “${due.instruction.slice(0, 50)}” — it failed ${AUTO_PAUSE_FAILURES} times in a row.`).catch(() => { /* best effort */ })
    }
    log.warn('routine_failed', { id: due.id, failures: due.failures })
  } finally {
    running = false
    await save(store, await mergeState(store, due))
  }
}

/** Re-load and merge the mutated routine (runs may overlap saves). */
async function mergeState(store: Store, updated: Routine): Promise<Routine[]> {
  const all = await load(store)
  const i = all.findIndex(r => r.id === updated.id)
  if (i >= 0) all[i] = updated
  return all
}

/** Parse a human schedule: "daily at 7:30", "every sunday at 17:00",
 *  "every 45 minutes". Returns null when unclear. */
export function parseSchedule(text: string): Routine['schedule'] | null {
  const t = text.toLowerCase().trim()
  let m = t.match(/every\s+(\d+)\s*(minutes?|mins?|hours?)/)
  if (m) {
    const n = Number(m[1])
    return { kind: 'interval', minutes: m[2]!.startsWith('h') ? n * 60 : n }
  }
  const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  m = t.match(/every\s+(\w+day)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/)
  if (m && DAYS.includes(m[1]!)) {
    let h = Number(m[2]); if (m[4] === 'pm' && h < 12) h += 12
    return { kind: 'weekly', day: DAYS.indexOf(m[1]!), at: `${String(h).padStart(2, '0')}:${m[3] || '00'}` }
  }
  m = t.match(/(?:daily|every\s*day|each\s*morning|every\s*morning)\s*(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/)
  if (m) {
    let h = Number(m[1]); if (m[3] === 'pm' && h < 12) h += 12
    return { kind: 'daily', at: `${String(h).padStart(2, '0')}:${m[2] || '00'}` }
  }
  return null
}
