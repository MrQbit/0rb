/**
 * Gifts & occasions (SPEC §8): yearly family events (birthdays,
 * anniversaries) get a T-10-day nudge with a pointer at what the orb
 * remembers about the person — the agent mines their memory file for
 * concrete ideas when asked, and orders ride the gifts tier (always-ask)
 * with the spoiler guard hiding everything from the recipient.
 */
import type { Store } from '../store/store.js'

const NUDGED_KEY = 'occasions:nudged'
const LEAD_DAYS = 10

export interface Occasion { title: string; date: string; who?: string; daysOut: number }

export async function upcomingOccasions(store: Store, now = new Date()): Promise<Occasion[]> {
  try {
    const { listEvents, nextOccurrence } = await import('../family/family.js')
    const today = now.toISOString().slice(0, 10)
    const out: Occasion[] = []
    for (const e of await listEvents(store)) {
      if (e.repeat !== 'yearly') continue
      const next = nextOccurrence(e.date, today)
      const days = Math.round((new Date(next + 'T00:00:00').getTime() - new Date(today + 'T00:00:00').getTime()) / 86400_000)
      if (days >= 0 && days <= LEAD_DAYS) out.push({ title: e.title, date: next, who: e.who, daysOut: days })
    }
    return out.sort((a, b) => a.daysOut - b.daysOut)
  } catch { return [] }
}

/** Loop lane: nudge once per occasion per year, at the lead-time edge. */
export async function tickOccasions(store: Store): Promise<void> {
  const ups = await upcomingOccasions(store)
  if (!ups.length) return
  let nudged: Record<string, number> = {}
  try { nudged = JSON.parse((await store.getKv(NUDGED_KEY)) || '{}') } catch { /* fresh */ }
  const { logEvent } = await import('../events/journal.js')
  for (const o of ups) {
    const key = `${o.title}:${o.date}`
    if (nudged[key]) continue
    nudged[key] = Date.now()
    await store.putKv(NUDGED_KEY, JSON.stringify(nudged), 60 * 86400)
    const when = o.daysOut === 0 ? 'today' : o.daysOut === 1 ? 'tomorrow' : `in ${o.daysOut} days`
    await logEvent(store, {
      kind: 'note', attention: 'notify', giftFor: o.who,
      summary: `${o.title} is ${when} (${o.date}). Want gift ideas? I'll check what I know about them — flowers day-of is always a fallback.`,
    })
  }
}
