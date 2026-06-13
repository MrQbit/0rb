/**
 * Home Assistant connector — the device backbone for Orb.
 *
 * Orb doesn't talk to lights/locks/thermostats directly; it drives a local
 * Home Assistant instance (self-hosted, free, Apache-2.0) over its REST API.
 * HA already speaks Matter / Zigbee / Z-Wave / Wi-Fi and ~1000 integrations,
 * so Orb gets every device the homeowner has paired without writing drivers.
 *
 * Config (set in the install / Settings):
 *   RAK00N_HA_URL    e.g. http://homeassistant:8123  (or http://localhost:8123)
 *   RAK00N_HA_TOKEN  a Home Assistant long-lived access token
 *
 * REST: GET /api/states, POST /api/services/<domain>/<service> with a JSON
 * body that targets an entity_id. Auth is a Bearer token.
 */

export function haEnabled(): boolean {
  return !!(haBaseUrl() && process.env.RAK00N_HA_TOKEN)
}

function haBaseUrl(): string {
  return (process.env.RAK00N_HA_URL || '').trim().replace(/\/+$/, '')
}

function haHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.RAK00N_HA_TOKEN || ''}`,
    'Content-Type': 'application/json',
  }
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
