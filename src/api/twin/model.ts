/**
 * The digital twin (SPEC §18) — a house the orb can point at.
 *
 * `twin:plan` maps the physical home: floors → rooms (grid coords for
 * distance math) → device placements. Seeded automatically from Home
 * Assistant areas (area ≈ room) so day one isn't blank; refined in
 * Settings (rename rooms, assign floors, move devices). Geometry powers
 * behavior: nearest-speaker replies, camera→room association, "everything
 * upstairs", room-tagged journal events.
 */
import type { Store } from '../store/store.js'

const PLAN_KEY = 'twin:plan'
const LONG_TTL_S = 60 * 60 * 24 * 365 * 5

export interface TwinRoom { id: string; name: string; floor: string; x: number; y: number }
export interface TwinPlan {
  floors: string[]
  rooms: TwinRoom[]
  /** entity_id (or bridge speaker id) → room id */
  placements: Record<string, string>
  seeded_at?: string
}

const EMPTY: TwinPlan = { floors: ['Main'], rooms: [], placements: {} }

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'room'
}

export async function getPlan(store: Store): Promise<TwinPlan> {
  try {
    const raw = await store.getKv(PLAN_KEY)
    if (raw) {
      const p = JSON.parse(raw)
      if (Array.isArray(p?.rooms)) return { ...EMPTY, ...p }
    }
  } catch { /* empty */ }
  return { ...EMPTY, rooms: [], placements: {} }
}

export async function savePlan(store: Store, plan: TwinPlan): Promise<void> {
  await store.putKv(PLAN_KEY, JSON.stringify(plan), LONG_TTL_S)
}

/**
 * Seed rooms + placements from HA areas. Existing rooms/placements are
 * KEPT (reseeding fills gaps, never destroys the owner's edits). Bridge
 * speakers are placed by fuzzy name match against rooms.
 */
export async function seedFromHa(store: Store): Promise<TwinPlan> {
  const plan = await getPlan(store)
  const have = new Set(plan.rooms.map(r => r.id))
  try {
    const { haEnabled, haStates, haJoinAreas } = await import('../connectors/homeAssistant.js')
    if (haEnabled()) {
      const states = await haJoinAreas(await haStates())
      const areas = new Set<string>()
      for (const s of states) if ((s as any).area) areas.add(String((s as any).area))
      let i = plan.rooms.length
      for (const area of Array.from(areas).sort()) {
        const id = slugify(area)
        if (!have.has(id)) {
          // auto grid layout: 4 per row, editable later
          plan.rooms.push({ id, name: area, floor: plan.floors[0] || 'Main', x: (i % 4) * 3, y: Math.floor(i / 4) * 3 })
          have.add(id); i++
        }
      }
      for (const s of states) {
        const area = (s as any).area
        if (area && !plan.placements[(s as any).entity_id]) {
          plan.placements[(s as any).entity_id] = slugify(String(area))
        }
      }
    }
  } catch { /* HA optional */ }
  // Bridge speakers (AirPlay ids aren't HA entities) — place by name match.
  try {
    const { bridgeEnabled, bridgeDevices } = await import('../connectors/bridge.js')
    if (bridgeEnabled()) {
      const { speakers } = await bridgeDevices()
      for (const sp of speakers) {
        if (plan.placements[sp.id]) continue
        const n = slugify(sp.name)
        const room = plan.rooms.find(r => r.id === n || n.includes(r.id) || r.id.includes(n))
        if (room) plan.placements[sp.id] = room.id
      }
    }
  } catch { /* bridge optional */ }
  plan.seeded_at = new Date().toISOString()
  await savePlan(store, plan)
  return plan
}

export function roomOf(plan: TwinPlan, id: string): TwinRoom | null {
  const rid = plan.placements[id]
  return plan.rooms.find(r => r.id === rid) ?? null
}

export function devicesIn(plan: TwinPlan, roomId: string): string[] {
  return Object.entries(plan.placements).filter(([, r]) => r === roomId).map(([e]) => e)
}

export function roomsOnFloor(plan: TwinPlan, floor: string): TwinRoom[] {
  const f = floor.toLowerCase()
  return plan.rooms.filter(r => r.floor.toLowerCase() === f)
}

function dist(a: TwinRoom, b: TwinRoom): number {
  const df = a.floor === b.floor ? 0 : 100          // floors are far apart
  return Math.hypot(a.x - b.x, a.y - b.y) + df
}

/**
 * Nearest device to `fromId` among `candidates` (ids placed in the plan).
 * Same room wins; then grid distance; unplaced candidates lose to placed.
 */
export function nearest(plan: TwinPlan, fromId: string, candidates: string[]): string | null {
  const from = roomOf(plan, fromId)
  if (!from) return candidates[0] ?? null
  let best: string | null = null; let bestD = Infinity
  for (const c of candidates) {
    const r = roomOf(plan, c)
    const d = r ? dist(from, r) : 1000
    if (d < bestD) { bestD = d; best = c }
  }
  return best
}
