/**
 * Home Assistant connector — the device backbone for Orb.
 *
 * Orb doesn't talk to lights/locks/thermostats directly; it drives a local
 * Home Assistant instance (self-hosted, free, Apache-2.0) over its REST API.
 * HA already speaks Matter / Zigbee / Z-Wave / Wi-Fi and ~1000 integrations,
 * so Orb gets every device the homeowner has paired without writing drivers.
 *
 * Config (set in the install / Settings):
 *   ORB2_HA_URL    e.g. http://homeassistant:8123  (or http://localhost:8123)
 *   ORB2_HA_TOKEN  a Home Assistant long-lived access token
 *
 * REST: GET /api/states, POST /api/services/<domain>/<service> with a JSON
 * body that targets an entity_id. Auth is a Bearer token.
 */

export function haEnabled(): boolean {
  return !!(haBaseUrl() && process.env.ORB2_HA_TOKEN)
}

function haBaseUrl(): string {
  return (process.env.ORB2_HA_URL || '').trim().replace(/\/+$/, '')
}

function haHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.ORB2_HA_TOKEN || ''}`,
    'Content-Type': 'application/json',
  }
}

export interface HaConfig {
  latitude?: number
  longitude?: number
  location_name?: string
  time_zone?: string
}

/** HA instance config (home coordinates, name, tz). null when unreachable. */
export async function haConfig(): Promise<HaConfig | null> {
  if (!haEnabled()) return null
  try { return (await haFetch('/config')) as HaConfig } catch { return null }
}

export interface HaEntity {
  entity_id: string
  domain: string
  name: string
  state: string
  area?: string
  attributes: Record<string, any>
}

function toEntity(raw: any): HaEntity {
  const entity_id: string = raw.entity_id || ''
  const domain = entity_id.split('.')[0] || ''
  return {
    entity_id,
    domain,
    name: raw.attributes?.friendly_name || entity_id,
    state: raw.state,
    attributes: raw.attributes || {},
  }
}

async function haFetch(path: string, init?: RequestInit): Promise<any> {
  const url = `${haBaseUrl()}/api${path}`
  const res = await fetch(url, { ...init, headers: { ...haHeaders(), ...(init?.headers || {}) } })
  if (!res.ok) throw new Error(`Home Assistant ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
  const ct = res.headers.get('content-type') || ''
  return ct.includes('application/json') ? res.json() : res.text()
}

/** All entities Orb can see, optionally filtered to a set of domains. */
export async function haStates(domains?: string[]): Promise<HaEntity[]> {
  const raw = (await haFetch('/states')) as any[]
  let list = raw.map(toEntity)
  if (domains?.length) list = list.filter(e => domains.includes(e.domain))
  return list
}

// ── WebSocket admin API ────────────────────────────────────────────────
// Registry operations (rename an entity, create/assign areas) are only
// exposed over HA's WebSocket API, not REST. Each call opens a socket,
// authenticates with the same long-lived token, runs one command, closes.

function haWsUrl(): string {
  return haBaseUrl().replace(/^http/, 'ws') + '/api/websocket'
}

async function haWsCommand(type: string, payload: Record<string, any> = {}): Promise<any> {
  if (!haEnabled()) throw new Error('Home Assistant is not configured')
  return await new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(haWsUrl())
    const timer = setTimeout(() => { try { ws.close() } catch { /* ignore */ } reject(new Error('Home Assistant WS timeout')) }, 10_000)
    const done = (fn: () => void) => { clearTimeout(timer); try { ws.close() } catch { /* ignore */ } fn() }
    ws.onerror = () => done(() => reject(new Error('Home Assistant WS connection failed')))
    ws.onmessage = ev => {
      let msg: any
      try { msg = JSON.parse(String(ev.data)) } catch { return }
      if (msg.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: process.env.ORB2_HA_TOKEN }))
      else if (msg.type === 'auth_invalid') done(() => reject(new Error('Home Assistant rejected the token')))
      else if (msg.type === 'auth_ok') ws.send(JSON.stringify({ id: 1, type, ...payload }))
      else if (msg.type === 'result' && msg.id === 1) {
        if (msg.success) done(() => resolvePromise(msg.result))
        else done(() => reject(new Error(msg.error?.message || 'Home Assistant command failed')))
      }
    }
  })
}

export interface HaArea { area_id: string; name: string }
export interface HaRegistryEntry { entity_id: string; area_id: string | null; name: string | null; hidden_by: string | null }

export async function haAreas(): Promise<HaArea[]> {
  const r = (await haWsCommand('config/area_registry/list')) as any[]
  return r.map(a => ({ area_id: a.area_id, name: a.name }))
}

export async function haCreateArea(name: string): Promise<HaArea> {
  const a = (await haWsCommand('config/area_registry/create', { name })) as any
  return { area_id: a.area_id, name: a.name }
}

export async function haEntityRegistry(): Promise<HaRegistryEntry[]> {
  const r = (await haWsCommand('config/entity_registry/list')) as any[]
  return r.map(e => ({ entity_id: e.entity_id, area_id: e.area_id ?? null, name: e.name ?? null, hidden_by: e.hidden_by ?? null }))
}

/** Update registry fields on an entity: display name, area, hidden. */
export async function haUpdateEntity(
  entityId: string,
  patch: { name?: string; area_id?: string | null; hidden?: boolean },
): Promise<void> {
  const payload: Record<string, any> = { entity_id: entityId }
  if (patch.name !== undefined) payload.name = patch.name
  if (patch.area_id !== undefined) payload.area_id = patch.area_id
  if (patch.hidden !== undefined) payload.hidden_by = patch.hidden ? 'user' : null
  await haWsCommand('config/entity_registry/update', payload)
}

export function prettyDomain(domain: string): string {
  const map: Record<string, string> = {
    light: 'Light', switch: 'Plug/Switch', climate: 'Thermostat', lock: 'Lock',
    cover: 'Shade', media_player: 'Media', vacuum: 'Vacuum', fan: 'Fan',
    binary_sensor: 'Sensor', sensor: 'Sensor', camera: 'Camera', scene: 'Scene',
  }
  return map[domain] || domain
}

export function describeAttrs(e: HaEntity): string {
  const a = e.attributes
  if (e.domain === 'climate') {
    const cur = a.current_temperature, tgt = a.temperature
    return [cur != null ? `now ${cur}°` : '', tgt != null ? `set ${tgt}°` : ''].filter(Boolean).join(', ')
  }
  if (e.domain === 'light' && a.brightness != null) return `${Math.round((a.brightness / 255) * 100)}% bright`
  if (e.domain === 'cover' && a.current_position != null) return `${a.current_position}% open`
  if (e.domain === 'media_player' && a.media_title) return `${a.media_title}`
  if (e.domain === 'sensor' && a.unit_of_measurement) return `${e.state}${a.unit_of_measurement}`
  return ''
}

/** Map an HA entity to the device card the home widget renders. */
export function toDeviceCard(e: HaEntity): any {
  let on: boolean | undefined
  if (e.domain === 'lock') on = e.state === 'locked'
  else if (e.domain === 'cover') on = e.state === 'open'
  else if (e.domain === 'media_player') on = !['off', 'idle', 'standby', 'unavailable'].includes(e.state)
  else if (['light', 'switch', 'fan'].includes(e.domain)) on = e.state === 'on'
  const controllable = ['light', 'switch', 'fan', 'lock', 'cover'].includes(e.domain)
  return {
    entity_id: e.entity_id,
    name: e.name,
    domain: e.domain,
    kind: prettyDomain(e.domain),
    state: e.state,
    on,
    sub: describeAttrs(e),
    area: e.area,
    controllable,
  }
}

/** Join area names onto entities (best-effort — WS registry may be slow). */
export async function haJoinAreas(entities: HaEntity[]): Promise<HaEntity[]> {
  try {
    const byEntity = await haAreaByEntity()
    for (const e of entities) e.area = byEntity.get(e.entity_id)
  } catch { /* areas are optional decoration */ }
  return entities
}

/** entity_id → area name map (joined across both registries). */
export async function haAreaByEntity(): Promise<Map<string, string>> {
  const [areas, reg] = await Promise.all([haAreas(), haEntityRegistry()])
  const areaName = new Map(areas.map(a => [a.area_id, a.name]))
  const out = new Map<string, string>()
  for (const e of reg) if (e.area_id && areaName.has(e.area_id)) out.set(e.entity_id, areaName.get(e.area_id)!)
  return out
}

/** The device domains Orb manages, in the order a home dashboard reads. */
export const HOME_DOMAINS = [
  'light', 'switch', 'climate', 'lock', 'cover', 'media_player',
  'vacuum', 'fan', 'binary_sensor', 'sensor', 'camera', 'scene',
]

/** Resolve a free-text reference ("kitchen lights", "front door") to entities,
 *  ranked by how well the friendly name / id matches. */
export function haResolve(entities: HaEntity[], query: string, domain?: string): HaEntity[] {
  const q = query.trim().toLowerCase()
  const words = q.split(/\s+/).filter(Boolean)
  const pool = domain ? entities.filter(e => e.domain === domain) : entities
  if (!q) return pool
  const scored = pool.map(e => {
    const hay = `${e.name} ${e.entity_id}`.toLowerCase()
    let score = 0
    if (hay.includes(q)) score += 5
    for (const w of words) if (hay.includes(w)) score += 1
    return { e, score }
  })
  return scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).map(s => s.e)
}

/** Call a Home Assistant service against an entity (e.g. light.turn_on). */
export async function haCallService(
  domain: string,
  service: string,
  entityId: string,
  data: Record<string, any> = {},
): Promise<void> {
  await haFetch(`/services/${domain}/${service}`, {
    method: 'POST',
    body: JSON.stringify({ entity_id: entityId, ...data }),
  })
}
