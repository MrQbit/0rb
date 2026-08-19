/**
 * Timers & alarms — the most-used feature of any home assistant.
 *
 * Timers live in the store (they survive restarts) and are checked by a
 * lightweight in-process loop. On expiry the owner is notified through the
 * same channel as home alerts (push/Telegram/log) and the timer widget is
 * refreshed on the session that set it.
 */
import type { Store } from '../store/store.js'
import { emitWidget } from '../widgets/bus.js'
import { log } from '../log.js'

const KEY = 'timers:active'

export interface OrbTimer {
  id: string
  label: string
  /** epoch ms when it fires */
  at: number
  /** epoch ms when it was set (for progress rendering) */
  set: number
  sessionId?: string
  /** deliver to this member instead of the owner (family reminders) */
  for?: string
}

export async function listTimers(store: Store): Promise<OrbTimer[]> {
  try { return JSON.parse((await store.getKv(KEY)) || '[]') } catch { return [] }
}
async function save(store: Store, timers: OrbTimer[]): Promise<void> {
  await store.putKv(KEY, JSON.stringify(timers), 0)
}

export async function addTimer(store: Store, label: string, at: number, sessionId?: string, forEmail?: string): Promise<OrbTimer> {
  const timers = await listTimers(store)
  const t: OrbTimer = { id: `t-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`, label: label.slice(0, 80), at, set: Date.now(), sessionId, for: forEmail }
  timers.push(t)
  await save(store, timers)
  return t
}

export async function cancelTimer(store: Store, idOrLabel: string): Promise<OrbTimer | null> {
  const timers = await listTimers(store)
  const q = idOrLabel.toLowerCase()
  const idx = timers.findIndex(t => t.id === idOrLabel || t.label.toLowerCase().includes(q))
  if (idx < 0) return null
  const [gone] = timers.splice(idx, 1)
  await save(store, timers)
  return gone!
}

export function timerWidgetSpec(timers: OrbTimer[]): any {
  return {
    id: 'timers', type: 'timers', title: 'Timers',
    pill: timers.length ? `${timers.length} running` : undefined,
    timers: timers.map(t => ({ id: t.id, label: t.label, at: t.at, set: t.set })),
  }
}

let loop: ReturnType<typeof setInterval> | null = null

/** Start the expiry loop (idempotent). notify = the home-alert channel. */
export function startTimerLoop(store: Store, notify: (text: string) => Promise<void>): void {
  if (loop) return
  loop = setInterval(async () => {
    try {
      const timers = await listTimers(store)
      const now = Date.now()
      const due = timers.filter(t => t.at <= now)
      if (!due.length) return
      const remaining = timers.filter(t => t.at > now)
      await save(store, remaining)
      for (const t of due) {
        const text = `⏱ ${t.label.replace(/ → .*$/, '')} — time's up!`
        let sent = false
        if (t.for) {
          try { const { notifyUser } = await import('../family/family.js'); sent = await notifyUser(store, t.for, text) } catch { /* fall through */ }
        }
        if (!sent) await notify(text)
        if (t.sessionId) { try { emitWidget(t.sessionId, timerWidgetSpec(remaining)) } catch { /* session gone */ } }
        log.info('timer_fired', { label: t.label })
      }
    } catch (err) {
      log.warn('timer_loop_error', { error: (err as Error).message })
    }
  }, 3000)
  ;(loop as any).unref?.()
}
