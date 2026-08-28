/**
 * Event journal + notification router v2 (SPEC §4).
 *
 * ONE append-only stream of "what happened" — receipts, orders, arrivals,
 * camera events, safety, deliveries, mode changes — powering the away
 * timeline ("what happened while I was gone"), the arrival catch-up card,
 * and sane notification routing: push when you're away and it matters,
 * silence when it doesn't, digest for everything in between.
 */
import type { Store } from '../store/store.js'
import { log } from '../log.js'

export type EventKind =
  | 'receipt' | 'order' | 'arrival' | 'departure' | 'camera' | 'safety'
  | 'device' | 'routine' | 'delivery' | 'mode' | 'spend' | 'note'
export type Attention = 'ambient' | 'glance' | 'notify' | 'interrupt'

export interface OrbEvent {
  id: string
  t: number
  kind: EventKind
  member?: string            // who it's about/for ('' = household)
  summary: string
  ref?: string               // receipt id / order id / camera event id
  attention: Attention
  giftFor?: string           // spoiler guard (§8): hidden from this member
}

const RING_KEY = 'journal:ring'
const CAP = 2000
const PREFS_KEY = (m: string) => `notif:prefs:${m}`

export async function listEvents(store: Store, opts: { since?: number; member?: string; max?: number } = {}): Promise<OrbEvent[]> {
  let ring: OrbEvent[] = []
  try { ring = JSON.parse((await store.getKv(RING_KEY)) || '[]') } catch { /* fresh */ }
  const cutoff = Date.now() - 14 * 86400_000
  let out = ring.filter(e => e.t >= cutoff && (!opts.since || e.t > opts.since))
  if (opts.member) {
    const m = opts.member.toLowerCase()
    // spoiler guard: gift events for me are invisible to me
    out = out.filter(e => e.giftFor?.toLowerCase() !== m)
  }
  return out.slice(-(opts.max ?? 200))
}

export interface NotifPrefs { quietStart?: number; quietEnd?: number; pushMin: Attention }
const DEFAULT_PREFS: NotifPrefs = { quietStart: 22, quietEnd: 7, pushMin: 'notify' }

export async function getNotifPrefs(store: Store, member: string): Promise<NotifPrefs> {
  try { return { ...DEFAULT_PREFS, ...JSON.parse((await store.getKv(PREFS_KEY(member))) || '{}') } } catch { return DEFAULT_PREFS }
}
export async function setNotifPrefs(store: Store, member: string, p: Partial<NotifPrefs>): Promise<void> {
  await store.putKv(PREFS_KEY(member), JSON.stringify(p), 0)
}

const RANK: Record<Attention, number> = { ambient: 0, glance: 1, notify: 2, interrupt: 3 }

function inQuietHours(p: NotifPrefs, d = new Date()): boolean {
  const h = d.getHours()
  const s = p.quietStart ?? 22, e = p.quietEnd ?? 7
  return s > e ? (h >= s || h < e) : (h >= s && h < e)
}

/**
 * Append an event and route it. Routing per member:
 *  - away + attention ≥ their push threshold → push (quiet hours demote
 *    everything but interrupt into the silent digest)
 *  - home → the console/speaker surfaces already carry it; no push
 *  - everything lands in the journal either way (that IS the digest).
 */
export async function logEvent(store: Store, e: Omit<OrbEvent, 'id' | 't'> & { t?: number }): Promise<OrbEvent> {
  const ev: OrbEvent = { id: `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`, t: e.t ?? Date.now(), ...e }
  let ring: OrbEvent[] = []
  try { ring = JSON.parse((await store.getKv(RING_KEY)) || '[]') } catch { /* fresh */ }
  ring.push(ev)
  if (ring.length > CAP) ring = ring.slice(-CAP)
  await store.putKv(RING_KEY, JSON.stringify(ring), 0).catch(() => {})
  void routeEvent(store, ev).catch(err => log.warn('route_event_failed', { error: (err as Error).message }))
  return ev
}

async function routeEvent(store: Store, ev: OrbEvent): Promise<void> {
  if (RANK[ev.attention] < RANK.notify) return   // ambient/glance never push
  const { pushEnabled, sendPush } = await import('../push/fcm.js')
  if (!pushEnabled()) return
  // who's away? (household-level push registry today; per-member tokens
  // arrive with companion v2 — route conservatively: push only when the
  // event's member — or anyone, for household events — is away)
  let anyoneAway = false
  try {
    const { listPresence } = await import('../presence/presence.js')
    const people = await listPresence(store)
    anyoneAway = people.some(p => !p.home)
  } catch { /* unknown → don't push */ }
  if (!anyoneAway && ev.attention !== 'interrupt') return
  const target = ev.member || ''
  const prefs = await getNotifPrefs(store, target || 'household')
  if (RANK[ev.attention] < RANK[prefs.pushMin]) return
  if (inQuietHours(prefs) && ev.attention !== 'interrupt') return
  await sendPush(store, ev.kind === 'safety' ? '⚠️ 0rb' : '0rb', ev.summary, { kind: ev.kind, ref: ev.ref || '', id: ev.id })
}

/** Compact grouped digest for "what happened while I was gone". */
export function digest(events: OrbEvent[]): { groups: Record<string, OrbEvent[]>; line: string } {
  const groups: Record<string, OrbEvent[]> = {}
  for (const e of events) {
    const g = e.kind === 'order' || e.kind === 'spend' || e.kind === 'delivery' ? 'orders & deliveries'
      : e.kind === 'arrival' || e.kind === 'departure' ? 'people'
      : e.kind === 'camera' || e.kind === 'safety' ? 'house & safety'
      : e.kind === 'receipt' || e.kind === 'mode' || e.kind === 'routine' ? 'actions'
      : 'other'
    ;(groups[g] ??= []).push(e)
  }
  const bits: string[] = []
  if (groups['people']?.length) bits.push(`${groups['people'].length} comings/goings`)
  if (groups['orders & deliveries']?.length) bits.push(`${groups['orders & deliveries'].length} order/delivery updates`)
  if (groups['house & safety']?.length) bits.push(`${groups['house & safety'].length} house events`)
  if (groups['actions']?.length) bits.push(`${groups['actions'].length} actions taken`)
  const line = bits.length ? `While you were out: ${bits.join(', ')}.` : 'All quiet while you were out.'
  return { groups, line }
}
