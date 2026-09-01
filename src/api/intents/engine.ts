/**
 * Standing intents (SPEC §15) — the agent's OWN proactive lanes.
 *
 * Every other lane in the tick chain is code we wrote (leave-by, replenish,
 * mail-watch…). An intent is a lane the AGENT writes: a goal it committed to
 * in conversation ("I'll watch for a price drop on your milk") or registered
 * for itself at dream time (a noticed habit worth monitoring). The engine
 * schedules due intents and gives each a bounded, headless agent turn — the
 * same runtime as a chat message, with the same tools, memory recall, trust
 * gates and receipts — then routes anything noteworthy through the journal's
 * attention rules. The worker reports back via the Watch tool's 'report' op
 * (kv mailbox); a turn that never reports is treated as quiet.
 *
 * Guardrails: max active intents per household, minimum cadence, default
 * expiry, at most INTENTS_PER_TICK runs per tick (serialized), wall-clock
 * timeout per run. Money/device actions inside a run still hit the normal
 * consent gradient — an unattended approval simply comes back "not
 * approved" and the worker escalates with a recommendation instead.
 */
import type { Store } from '../store/store.js'
import { log } from '../log.js'

const INTENTS_KEY = 'intents:all'
const REPORT_KEY = (id: string) => `intents:report:${id}`
const LONG_TTL_S = 60 * 60 * 24 * 365 * 5

export const MAX_ACTIVE = 20
export const MIN_CADENCE_MIN = 30
const DEFAULT_EXPIRES_DAYS = 60
const KEEP_FINISHED_DAYS = 30
const INTENTS_PER_TICK = 2
const RUN_TIMEOUT_MS = 4 * 60_000

export type IntentStatus = 'active' | 'paused' | 'done' | 'expired'
export type IntentOutcome = 'quiet' | 'notify' | 'done'

export interface Intent {
  id: string
  /** The worker turn's charter, in natural language. */
  goal: string
  /** Member email this intent serves — notifications route to them. */
  member: string
  cadence_min: number
  /** epoch ms of the next due run */
  next_at: number
  /** Worker-maintained scratchpad carried between runs (baseline, seen-set…). */
  state: string
  status: IntentStatus
  origin: 'chat' | 'dream'
  runs: number
  created_at: string
  expires_at: string
  last_run_at?: number
  last_result?: IntentOutcome | 'error' | 'no-report'
  /** Last notify/done message, for the Settings list. */
  last_note?: string
}

export interface IntentReport { outcome: IntentOutcome; state?: string; message?: string }

/** Parse 'hourly' | 'daily' | 'weekly' | '2h' | '45m' | '3d' | minutes. */
export function parseCadence(c: unknown): number {
  if (typeof c === 'number' && Number.isFinite(c)) return Math.max(MIN_CADENCE_MIN, Math.round(c))
  const s = String(c ?? '').trim().toLowerCase()
  const named: Record<string, number> = { hourly: 60, daily: 1440, weekly: 10080, monthly: 43200 }
  if (named[s]) return named[s]!
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(m|min|minutes?|h|hours?|d|days?|w|weeks?)$/)
  if (m) {
    const n = Number(m[1])
    const unit = m[2]![0]
    const mult = unit === 'm' ? 1 : unit === 'h' ? 60 : unit === 'd' ? 1440 : 10080
    return Math.max(MIN_CADENCE_MIN, Math.round(n * mult))
  }
  return 1440 // default daily
}

export async function listIntents(store: Store): Promise<Intent[]> {
  try {
    const arr = JSON.parse((await store.getKv(INTENTS_KEY)) || '[]') as Intent[]
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

async function saveIntents(store: Store, all: Intent[]): Promise<void> {
  // Drop finished intents after a grace window so the list stays legible.
  const cutoff = Date.now() - KEEP_FINISHED_DAYS * 86400_000
  const kept = all.filter(i => i.status === 'active' || i.status === 'paused'
    || new Date(i.created_at).getTime() > cutoff || (i.last_run_at ?? 0) > cutoff)
  await store.putKv(INTENTS_KEY, JSON.stringify(kept), LONG_TTL_S)
}

export async function addIntent(store: Store, o: {
  goal: string; member: string; cadence?: unknown; expires_days?: number; origin?: 'chat' | 'dream'
}): Promise<{ ok: boolean; intent?: Intent; error?: string }> {
  const goal = String(o.goal || '').trim()
  if (goal.length < 8) return { ok: false, error: 'goal too short — say what to watch and when to speak up' }
  const all = await listIntents(store)
  const active = all.filter(i => i.status === 'active')
  if (active.length >= MAX_ACTIVE) return { ok: false, error: `already ${MAX_ACTIVE} active watches — cancel one first` }
  const dupe = active.find(i => i.goal.toLowerCase() === goal.toLowerCase())
  if (dupe) return { ok: false, error: `already watching that (${dupe.id})` }
  const cadence = parseCadence(o.cadence)
  const days = Math.min(365, Math.max(1, Number(o.expires_days) || DEFAULT_EXPIRES_DAYS))
  const intent: Intent = {
    id: `in-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    goal, member: o.member, cadence_min: cadence,
    // First run on the next tick: report early that the watch is live.
    next_at: Date.now(),
    state: '', status: 'active', origin: o.origin ?? 'chat', runs: 0,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + days * 86400_000).toISOString(),
  }
  all.push(intent)
  await saveIntents(store, all)
  return { ok: true, intent }
}

export async function updateIntent(store: Store, id: string, patch: Partial<Pick<Intent, 'status' | 'state' | 'next_at' | 'cadence_min' | 'last_result' | 'last_run_at' | 'last_note' | 'runs'>>): Promise<Intent | null> {
  const all = await listIntents(store)
  const it = all.find(i => i.id === id)
  if (!it) return null
  Object.assign(it, patch)
  await saveIntents(store, all)
  return it
}

export async function removeIntent(store: Store, id: string): Promise<boolean> {
  const all = await listIntents(store)
  const next = all.filter(i => i.id !== id)
  if (next.length === all.length) return false
  await saveIntents(store, next)
  return true
}

/** The worker's report mailbox (written by the Watch tool's 'report' op). */
export async function fileReport(store: Store, id: string, r: IntentReport): Promise<void> {
  await store.putKv(REPORT_KEY(id), JSON.stringify(r), 3600)
}
async function takeReport(store: Store, id: string): Promise<IntentReport | null> {
  try {
    const raw = await store.getKv(REPORT_KEY(id))
    if (!raw) return null
    await store.delKv(REPORT_KEY(id)).catch(() => {})
    const r = JSON.parse(raw)
    return ['quiet', 'notify', 'done'].includes(r?.outcome) ? r : null
  } catch { return null }
}

let running = false

/** Loop lane: run due intents through headless agent turns, route results. */
export async function tickIntents(
  store: Store,
  // Injectable for tests; the default is the real headless worker turn.
  runTurn?: (store: Store, intent: Intent) => Promise<void>,
): Promise<void> {
  if (running) return
  running = true
  try {
    const now = Date.now()
    const all = await listIntents(store)
    let dirty = false
    for (const i of all) {
      if (i.status === 'active' && new Date(i.expires_at).getTime() < now) {
        i.status = 'expired'; dirty = true
        const { logEvent } = await import('../events/journal.js')
        await logEvent(store, { kind: 'note', member: i.member, attention: 'ambient', summary: `Watch expired: ${i.goal.slice(0, 80)} — say the word to renew it.` }).catch(() => {})
      }
    }
    if (dirty) await saveIntents(store, all)
    const due = all.filter(i => i.status === 'active' && i.next_at <= now)
      .sort((a, b) => a.next_at - b.next_at).slice(0, INTENTS_PER_TICK)
    for (const intent of due) {
      // Reschedule BEFORE running so a crash can't hot-loop the same intent.
      await updateIntent(store, intent.id, { next_at: now + intent.cadence_min * 60_000 })
      const worker = runTurn ?? (await import('./turn.js')).runIntentTurn
      try {
        await Promise.race([
          worker(store, intent),
          new Promise((_, rej) => setTimeout(() => rej(new Error('intent run timeout')), RUN_TIMEOUT_MS)),
        ])
      } catch (e) {
        log.warn('intent_run_failed', { id: intent.id, error: (e as Error).message })
        await updateIntent(store, intent.id, { last_result: 'error', last_run_at: Date.now(), runs: intent.runs + 1 })
        continue
      }
      const report = await takeReport(store, intent.id)
      const patch: Parameters<typeof updateIntent>[2] = {
        last_run_at: Date.now(), runs: intent.runs + 1,
        last_result: report ? report.outcome : 'no-report',
      }
      if (report?.state !== undefined) patch.state = String(report.state).slice(0, 4000)
      if (report?.message) patch.last_note = String(report.message).slice(0, 500)
      if (report?.outcome === 'done') patch.status = 'done' as IntentStatus
      await updateIntent(store, intent.id, patch as any)
      if (report && (report.outcome === 'notify' || report.outcome === 'done') && report.message) {
        const { logEvent } = await import('../events/journal.js')
        await logEvent(store, {
          kind: 'note', member: intent.member, attention: 'notify', ref: intent.id,
          summary: `Watch — ${String(report.message).slice(0, 300)}`,
        }).catch(() => {})
      }
    }
  } finally {
    running = false
  }
}
