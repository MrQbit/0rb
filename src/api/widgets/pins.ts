/**
 * Pinned, malleable widgets (v0.2 §6) — the Ink & Switch prescription made
 * concrete: a widget the user keeps is a durable per-member OBJECT. Editing
 * it ("add humidity to my weather card") is a spec diff — the agent re-emits
 * the same id, the pinned copy updates, history keeps the last 5 versions
 * so any edit can be reverted.
 */
import type { Store } from '../store/store.js'

export interface PinnedWidget {
  spec: any
  pinnedAt: number
  updatedAt: number
  history: any[]        // previous specs, newest first, max 5
}

const key = (user: string) => `pins:${user}`

async function load(store: Store, user: string): Promise<Record<string, PinnedWidget>> {
  try { return JSON.parse((await store.getKv(key(user))) || '{}') } catch { return {} }
}
async function save(store: Store, user: string, pins: Record<string, PinnedWidget>): Promise<void> {
  await store.putKv(key(user), JSON.stringify(pins), 0)
}

export async function listPins(store: Store, user: string): Promise<any[]> {
  const pins = await load(store, user)
  return Object.values(pins).sort((a, b) => a.pinnedAt - b.pinnedAt).map(p => p.spec)
}

export async function pinnedIds(store: Store, user: string): Promise<string[]> {
  return Object.keys(await load(store, user))
}

export async function pinWidget(store: Store, user: string, spec: any): Promise<boolean> {
  if (!spec?.id || !spec?.type) return false
  const pins = await load(store, user)
  pins[spec.id] = { spec, pinnedAt: pins[spec.id]?.pinnedAt ?? Date.now(), updatedAt: Date.now(), history: pins[spec.id]?.history ?? [] }
  await save(store, user, pins)
  return true
}

/** Edit-by-diff: a re-emitted spec updates the pinned copy, keeping history. */
export async function updatePinned(store: Store, user: string, spec: any): Promise<boolean> {
  if (!spec?.id) return false
  const pins = await load(store, user)
  const p = pins[spec.id]
  if (!p) return false
  if (JSON.stringify(p.spec) === JSON.stringify(spec)) return true   // no-op
  p.history.unshift(p.spec)
  p.history = p.history.slice(0, 5)
  p.spec = spec
  p.updatedAt = Date.now()
  await save(store, user, pins)
  return true
}

export async function revertPinned(store: Store, user: string, id: string): Promise<any | null> {
  const pins = await load(store, user)
  const p = pins[id]
  if (!p || !p.history.length) return null
  p.spec = p.history.shift()
  p.updatedAt = Date.now()
  await save(store, user, pins)
  return p.spec
}

export async function unpinWidget(store: Store, user: string, id: string): Promise<boolean> {
  const pins = await load(store, user)
  if (!pins[id]) return false
  delete pins[id]
  await save(store, user, pins)
  return true
}

/**
 * The composed board (kiosk/idle surfaces): the member's pins first, then
 * contextual autos by time of day — rules, not a model. Only ambient/glance
 * tiers may appear; interruption is never a layout choice.
 */
export async function composeBoard(store: Store, user: string, now = new Date()): Promise<any[]> {
  const { attentionOf } = await import('./catalog.js')
  const out: any[] = []
  const seen = new Set<string>()
  for (const spec of await listPins(store, user)) {
    if (['ambient', 'glance'].includes(attentionOf(spec.type))) { out.push(spec); seen.add(spec.type) }
  }
  const hour = now.getHours()
  const autos: any[] = []
  // Always: the house at a glance.
  try {
    const { getMode } = await import('../home/mode.js')
    autos.push({ id: 'board-mode', type: 'housemode', title: 'House mode', mode: await getMode(store) })
  } catch { /* mode optional */ }
  try {
    const { listPresence } = await import('../presence/presence.js')
    const people = (await listPresence(store)).map(p => ({ name: p.name, home: p.home }))
    if (people.length) autos.push({ id: 'board-presence', type: 'presence', title: "Who's home", people })
  } catch { /* presence optional */ }
  if (hour >= 5 && hour < 12) {
    try {
      const { listTimers, timerWidgetSpec } = await import('../home/timers.js')
      const timers = await listTimers(store)
      if (timers.length) autos.push(timerWidgetSpec(timers))
    } catch { /* timers optional */ }
  } else if (hour >= 17) {
    try {
      const { haEnabled, haStates } = await import('../connectors/homeAssistant.js')
      if (haEnabled()) {
        const locks = (await haStates(['lock'])).map(l => ({ entity_id: l.entity_id, name: l.name, locked: l.state === 'locked' }))
        const sensors = (await haStates(['binary_sensor']))
          .filter(s => ['door', 'window', 'opening'].includes(String(s.attributes.device_class)))
          .map(s => ({ entity_id: s.entity_id, name: s.name, kind: String(s.attributes.device_class), on: s.state === 'on' }))
        if (locks.length || sensors.length) autos.push({ id: 'board-security', type: 'security', title: 'Security', locks, sensors })
      }
    } catch { /* HA optional */ }
  }
  for (const a of autos) if (!seen.has(a.type)) out.push(a)
  return out
}
