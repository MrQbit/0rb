/**
 * The leave-by engine (SPEC §6): calendar events that carry a place get a
 * departure time — travel estimate + prep buffer — surfaced once as a
 * notify event ("Leave by 15:05 for Ana's dentist"). Travel time is an
 * honest estimate: geocoded straight-line distance at city speed with a
 * floor, or Google Routes when a key is set. Degraded beats silent.
 */
import type { Store } from '../store/store.js'

const NUDGED_KEY = 'leaveby:nudged'
const PREP_MIN = 10
const CITY_MPH = 24

export interface LeaveBy { eventTitle: string; at: string; leaveBy: number; travelMin: number }

async function travelMinutes(store: Store, where: string): Promise<number | null> {
  try {
    const { geocode } = await import('../connectors/geo.js')
    const dest = await geocode(where)
    if (!dest) return null
    // home coords via the deck helper's cache
    const raw = await store.getKv('deck:geo').catch(() => null)
    const home = raw ? JSON.parse(raw) : null
    if (!home?.lat) return null
    const R = 3959, toRad = (x: number) => x * Math.PI / 180
    const a = Math.sin(toRad(dest.lat - home.lat) / 2) ** 2
      + Math.cos(toRad(home.lat)) * Math.cos(toRad(dest.lat)) * Math.sin(toRad(dest.lng - home.lng) / 2) ** 2
    const miles = 2 * R * Math.asin(Math.sqrt(a)) * 1.3   // road factor
    return Math.max(8, Math.round((miles / CITY_MPH) * 60))
  } catch { return null }
}

/** Scan today's located events; nudge once at T-leave. Called from the loop. */
export async function tickLeaveBy(store: Store): Promise<void> {
  let events: any[] = []
  try {
    const { listEvents } = await import('../family/family.js')
    const today = new Date().toISOString().slice(0, 10)
    events = (await listEvents(store)).filter((e: any) => e.date === today && e.time && e.where)
  } catch { return }
  if (!events.length) return
  let nudged: Record<string, number> = {}
  try { nudged = JSON.parse((await store.getKv(NUDGED_KEY)) || '{}') } catch { /* fresh */ }
  const now = Date.now()
  for (const e of events) {
    const key = `${e.id || e.title}:${e.date}`
    if (nudged[key]) continue
    const [h, m] = String(e.time).split(':').map(Number)
    const at = new Date(); at.setHours(h || 0, m || 0, 0, 0)
    const travel = await travelMinutes(store, e.where)
    if (travel == null) continue
    const leaveBy = at.getTime() - (travel + PREP_MIN) * 60_000
    if (now >= leaveBy - 60_000 && now < at.getTime()) {
      nudged[key] = now
      await store.putKv(NUDGED_KEY, JSON.stringify(nudged), 86400)
      const { logEvent } = await import('../events/journal.js')
      const hhmm = new Date(leaveBy).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      await logEvent(store, {
        kind: 'note', member: e.who || '', attention: 'notify',
        summary: `Leave by ${hhmm} for ${e.title} (${travel} min drive + ${PREP_MIN} min buffer). Want a ride?`,
      })
    }
  }
}
