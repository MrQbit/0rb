/**
 * Remote eyes (SPEC §12): cameras with memory. Motion/doorbell sensors
 * trigger a keyframe capture from the associated camera; the frame lands
 * in a size-capped ring and the event in the journal — so "what did you
 * see at the front door at 3?" is answerable hours later, from anywhere.
 * Watchers are watched: every remote view is itself journaled.
 */
import type { Store } from '../store/store.js'

const FRAME_KEY = (id: string) => `camera:frame:${id}`
const RING_KEY = 'camera:events'
const RING_CAP = 120                       // ~7 days of sane traffic
const FRAME_TTL_S = 7 * 24 * 3600

export interface CamEvent { id: string; t: number; camera: string; cameraName: string; trigger: string; area?: string }

const TRIGGERS = new Set(['motion', 'occupancy', 'door', 'garage_door', 'opening'])
const lastFired = new Map<string, number>()
const DEBOUNCE_MS = 120_000

export async function listCamEvents(store: Store, since?: number): Promise<CamEvent[]> {
  try {
    const ring: CamEvent[] = JSON.parse((await store.getKv(RING_KEY)) || '[]')
    return since ? ring.filter(e => e.t > since) : ring
  } catch { return [] }
}

export async function getFrameJpeg(store: Store, eventId: string): Promise<Buffer | null> {
  const raw = await store.getKv(FRAME_KEY(eventId)).catch(() => null)
  return raw ? Buffer.from(raw, 'base64') : null
}

/** Sensor→camera association: same area, else name-word overlap. */
export function associateCamera(sensor: { name: string; area?: string }, cameras: Array<{ entity_id: string; name: string; area?: string }>): { entity_id: string; name: string } | null {
  if (!cameras.length) return null
  if (sensor.area) {
    const byArea = cameras.find(c => c.area && c.area === sensor.area)
    if (byArea) return byArea
  }
  const words = sensor.name.toLowerCase().split(/\s+/)
  const byName = cameras.find(c => words.some(w => w.length > 3 && c.name.toLowerCase().includes(w)))
  return byName ?? cameras[0]!
}

/** Loop lane: watch trigger sensors; capture + journal on rising edge. */
export async function tickCameraEvents(store: Store): Promise<void> {
  const { haEnabled, haStates, haJoinAreas } = await import('../connectors/homeAssistant.js')
  if (!haEnabled()) return
  const [bins, cams] = await Promise.all([
    haJoinAreas(await haStates(['binary_sensor'])).catch(() => [] as any[]),
    haJoinAreas(await haStates(['camera'])).catch(() => [] as any[]),
  ])
  if (!cams.length) return
  for (const s of bins) {
    const cls = String(s.attributes?.device_class || '')
    if (!TRIGGERS.has(cls) || s.state !== 'on') continue
    const last = lastFired.get(s.entity_id) || 0
    if (Date.now() - last < DEBOUNCE_MS) continue
    lastFired.set(s.entity_id, Date.now())
    const cam = associateCamera({ name: s.name, area: s.area }, cams)
    if (!cam) continue
    await captureCameraEvent(store, { trigger: `${s.name} (${cls})`, camera: cam.entity_id, cameraName: (cam as any).name, area: s.area })
  }
}

export async function captureCameraEvent(store: Store, o: { trigger: string; camera: string; cameraName: string; area?: string }): Promise<CamEvent | null> {
  const ev: CamEvent = { id: `cam-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`, t: Date.now(), camera: o.camera, cameraName: o.cameraName, trigger: o.trigger, area: o.area }
  // keyframe via HA camera proxy
  try {
    const base = (process.env.ORB2_HA_URL || '').replace(/\/+$/, '')
    const r = await fetch(`${base}/api/camera_proxy/${o.camera}`, {
      headers: { Authorization: `Bearer ${process.env.ORB2_HA_TOKEN || ''}` }, signal: AbortSignal.timeout(8000),
    })
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer())
      if (buf.length > 0 && buf.length < 800_000) {
        await store.putKv(FRAME_KEY(ev.id), buf.toString('base64'), FRAME_TTL_S)
      }
    }
  } catch { /* event still counts without a frame */ }
  let ring: CamEvent[] = []
  try { ring = JSON.parse((await store.getKv(RING_KEY)) || '[]') } catch { /* fresh */ }
  ring.push(ev)
  // frame ring: drop frames that fall off the ring
  for (const dropped of ring.slice(0, Math.max(0, ring.length - RING_CAP))) {
    await store.delKv(FRAME_KEY(dropped.id)).catch(() => {})
  }
  ring = ring.slice(-RING_CAP)
  await store.putKv(RING_KEY, JSON.stringify(ring), 0)
  const { logEvent } = await import('../events/journal.js')
  await logEvent(store, { kind: 'camera', summary: `${o.cameraName}: ${o.trigger}`, ref: ev.id, attention: 'notify' })
  // Digital twin (§18): motion is an inside-presence signal for the room.
  try {
    const { getPlan, roomOf, slugify } = await import('../twin/model.js')
    const { recordRoomSignal } = await import('../twin/presence.js')
    const plan = await getPlan(store)
    const room = roomOf(plan, o.camera)?.id || (o.area ? slugify(o.area) : null)
    if (room) await recordRoomSignal(store, room, 'motion')
  } catch { /* presence is best-effort */ }
  return ev
}

/** Watched watchers: remote viewing is itself an event. */
export async function noteView(store: Store, member: string, what: string): Promise<void> {
  const { logEvent } = await import('../events/journal.js')
  await logEvent(store, { kind: 'note', member, summary: `${member.split('@')[0]} viewed ${what}`, attention: 'ambient' })
}
