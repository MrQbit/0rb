/**
 * Presence (SPEC §18.3) — two tiers, consent-shaped.
 *
 * INSIDE (no app): room-level signals from things the house already sees —
 * motion/occupancy through the twin, which satellite heard a wake word,
 * camera person events. Attribution is honest: a signal without an
 * identified member records "someone". Confidence decays; stale presence
 * degrades to "home, somewhere" rather than guessing.
 *
 * OUTSIDE (app only): a member's coarse location may be recorded ONLY when
 * that member has turned on location sharing THEMSELF. The owner cannot
 * enable it for anyone else — consent belongs to the member. Data: geohash
 * + timestamp, single current value, no trail.
 *
 * WATCHED WATCHERS: whenever one member asks where another is, the query
 * itself is journaled and visible to the person being asked about.
 */
import type { Store } from '../store/store.js'

const ROOM_KEY = 'twin:presence:rooms'          // roomId → {t, member?}
const SHARE_KEY = (email: string) => `twin:share:${email.toLowerCase()}`
const LOC_KEY = (email: string) => `twin:loc:${email.toLowerCase()}`
const STALE_MS = 20 * 60_000                    // room signal fades after 20m

export interface RoomSignal { t: number; member?: string; source: string }

export async function recordRoomSignal(store: Store, roomId: string, source: string, member?: string): Promise<void> {
  let map: Record<string, RoomSignal> = {}
  try { map = JSON.parse((await store.getKv(ROOM_KEY)) || '{}') } catch { /* fresh */ }
  map[roomId] = { t: Date.now(), source, ...(member ? { member } : {}) }
  await store.putKv(ROOM_KEY, JSON.stringify(map), 86400).catch(() => {})
}

export async function currentRooms(store: Store): Promise<Record<string, RoomSignal>> {
  try {
    const map: Record<string, RoomSignal> = JSON.parse((await store.getKv(ROOM_KEY)) || '{}')
    const now = Date.now()
    return Object.fromEntries(Object.entries(map).filter(([, s]) => now - s.t < STALE_MS))
  } catch { return {} }
}

// ── Outside tier: consent + location ─────────────────────────────────────

export async function getShare(store: Store, email: string): Promise<boolean> {
  return (await store.getKv(SHARE_KEY(email)).catch(() => null)) === '1'
}

/**
 * Toggle location sharing. HARD RULE: only the member themself may change
 * their flag — an owner (or anyone else) setting another member's share is
 * refused by construction.
 */
export async function setShare(store: Store, actor: string, member: string, on: boolean): Promise<{ ok: boolean; error?: string }> {
  if (actor.toLowerCase() !== member.toLowerCase()) {
    return { ok: false, error: 'location sharing can only be changed by that member themself' }
  }
  if (on) await store.putKv(SHARE_KEY(member), '1', 60 * 60 * 24 * 365 * 5)
  else {
    await store.delKv(SHARE_KEY(member)).catch(() => {})
    await store.delKv(LOC_KEY(member)).catch(() => {})   // revoke = forget
  }
  return { ok: true }
}

/** App-reported coarse location — rejected without the member's own opt-in. */
export async function reportLocation(store: Store, member: string, geohash: string): Promise<{ ok: boolean; error?: string }> {
  if (!(await getShare(store, member))) return { ok: false, error: 'location sharing is off for this member' }
  await store.putKv(LOC_KEY(member), JSON.stringify({ geohash: geohash.slice(0, 7), t: Date.now() }), 6 * 3600)
  return { ok: true }
}

export async function getLocation(store: Store, member: string): Promise<{ geohash: string; t: number } | null> {
  if (!(await getShare(store, member))) return null
  try { return JSON.parse((await store.getKv(LOC_KEY(member))) || 'null') } catch { return null }
}

/** Watched watchers: cross-member presence queries are journaled. */
export async function noteWhereQuery(store: Store, asker: string, target: string): Promise<void> {
  if (asker.toLowerCase() === target.toLowerCase()) return
  try {
    const { logEvent } = await import('../events/journal.js')
    await logEvent(store, {
      kind: 'note', member: target, attention: 'ambient',
      summary: `${asker.split('@')[0]} asked where ${target.split('@')[0]} is`,
    })
  } catch { /* best effort */ }
}
