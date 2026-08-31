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

// ── Integration / config-flow admin (agent-driven device setup) ────────
export interface HaConfigEntry { entry_id: string; domain: string; title: string; state: string }

export async function haConfigEntries(): Promise<HaConfigEntry[]> {
  const r = (await haWsCommand('config_entries/get')) as any[]
  return r.map(e => ({ entry_id: e.entry_id, domain: e.domain, title: e.title, state: e.state }))
}

export interface HaFlow { flow_id: string; handler: string; step_id?: string }

/** Discovered-but-unconfigured devices (HA's "found on your network" queue). */
export async function haDiscoveredFlows(): Promise<HaFlow[]> {
  const r = (await haWsCommand('config_entries/flow/progress')) as any[]
  return r.map(f => ({ flow_id: f.flow_id, handler: f.handler, step_id: f.context?.source }))
}

/** Advance a config flow one step (empty data = confirm). Returns HA's raw
 *  flow result: { type: 'form'|'create_entry'|'abort', step_id?, errors?,
 *  data_schema?, reason? }. */
export async function haFlowAdvance(flowId: string, data: Record<string, any> = {}): Promise<any> {
  return await haFetch(`/config/config_entries/flow/${flowId}`, {
    method: 'POST', body: JSON.stringify(data),
  })
}

/** Current form/step of a flow (fields it is asking for). */
export async function haFlowStatus(flowId: string): Promise<any> {
  return await haFetch(`/config/config_entries/flow/${flowId}`)
}

/**
 * Compact behaviour digest from HA history: for each on/off-style entity,
 * the hours of day when it typically turns ON (last `days` days). Feeds the
 * agent's automation suggestions — data prep here, reasoning in the model.
 */
export async function haPatternDigest(days = 7): Promise<string> {
  const entities = (await haStates(['light', 'switch', 'media_player', 'lock', 'climate'])).slice(0, 25)
  if (!entities.length) return 'No devices to analyze.'
  const start = new Date(Date.now() - days * 86_400_000).toISOString()
  const ids = entities.map(e => e.entity_id).join(',')
  let hist: any[]
  try {
    hist = (await haFetch(`/history/period/${start}?filter_entity_id=${encodeURIComponent(ids)}&minimal_response&no_attributes`)) as any[]
  } catch (e) { return `History unavailable: ${(e as Error).message}` }
  const lines: string[] = []
  for (const series of hist ?? []) {
    if (!Array.isArray(series) || !series.length) continue
    const id = series[0].entity_id
    const name = entities.find(e => e.entity_id === id)?.name || id
    const onHours: number[] = []
    for (const point of series) {
      const st = String(point.state)
      if (['on', 'playing', 'unlocked', 'heat', 'cool'].includes(st) && point.last_changed) {
        onHours.push(new Date(point.last_changed).getHours())
      }
    }
    if (onHours.length < 3) continue
    const hist24 = new Array(24).fill(0)
    for (const h of onHours) hist24[h]++
    const peaks = hist24.map((c, h) => ({ h, c })).filter(x => x.c >= 2).sort((a, b) => b.c - a.c).slice(0, 3)
    if (peaks.length) lines.push(`${name}: activates around ${peaks.map(p => `${p.h}:00 (${p.c}x)`).join(', ')} over ${days}d`)
  }
  return lines.length ? lines.join('\n') : 'Not enough activity history yet to find patterns.'
}

/** Create (or replace) an automation via HA's config API. */
export async function haCreateAutomation(autoId: string, body: Record<string, any>): Promise<void> {
  await haFetch(`/config/automation/config/${autoId}`, { method: 'POST', body: JSON.stringify(body) })
}

/** Dismiss a pending discovered flow (e.g. the generic-IPP twin of a
 *  printer already set up natively). HA re-discovers if it reappears. */
export async function haFlowDismiss(flowId: string): Promise<void> {
  await haFetch(`/config/config_entries/flow/${flowId}`, { method: 'DELETE' })
}

/** Start a brand-new integration setup flow (e.g. handler 'roomba'). */
export async function haFlowStart(handler: string): Promise<any> {
  return await haFetch('/config/config_entries/flow', {
    method: 'POST', body: JSON.stringify({ handler, show_advanced_options: false }),
  })
}

export interface FlowField { name: string; type: string; required: boolean; options?: string[]; label?: string; help?: string; option_labels?: Record<string, string> }
export interface FlowView {
  type: 'form' | 'create_entry' | 'abort' | 'unknown'
  flow_id?: string
  handler?: string
  step_id?: string
  title?: string
  reason?: string
  errors?: Record<string, string>
  fields?: FlowField[]
  placeholders?: Record<string, string>
  /** Human strings from HA's translation catalog (filled by translateFlowView). */
  step_title?: string
  step_description?: string
  errors_text?: string[]
  abort_text?: string
}

/** Translation catalog for one integration's config flows (cached — the
 *  strings HA's own UI shows: step titles, field labels, error messages). */
const _flowI18n = new Map<string, Record<string, string>>()
async function haFlowStrings(domain: string): Promise<Record<string, string>> {
  const hit = _flowI18n.get(domain)
  if (hit) return hit
  const res = (await haWsCommand('frontend/get_translations', {
    language: 'en', category: 'config', integration: domain,
  })) as any
  const strings = (res?.resources ?? {}) as Record<string, string>
  _flowI18n.set(domain, strings)
  return strings
}

/** The integration's display name from its manifest ("brother" → "Brother Printer"). */
const _manifestNames = new Map<string, string>()
export async function haIntegrationName(domain: string): Promise<string> {
  const hit = _manifestNames.get(domain)
  if (hit) return hit
  let name = domain
  try {
    const m = (await haWsCommand('manifest/get', { integration: domain })) as any
    if (m?.name) name = String(m.name)
  } catch {}
  _manifestNames.set(domain, name)
  return name
}

/**
 * Merge HA's human strings into a flow view so forms read like HA's own UI —
 * "Type of the printer", "The printer is not supported" — instead of raw
 * schema names and error codes. Best-effort: missing strings stay undefined
 * and the UI falls back to prettified names.
 */
export async function translateFlowView(view: FlowView): Promise<FlowView> {
  if (!view.handler) return view
  try {
    const r = await haFlowStrings(view.handler)
    const p = `component.${view.handler}.config`
    const fill = (s?: string) => s?.replace(/\{(\w+)\}/g, (_, k) => view.placeholders?.[k] ?? `{${k}}`)
    if (view.step_id) {
      view.step_title = fill(r[`${p}.step.${view.step_id}.title`])
      view.step_description = fill(r[`${p}.step.${view.step_id}.description`])
      for (const f of view.fields ?? []) {
        f.label = r[`${p}.step.${view.step_id}.data.${f.name}`]
        f.help = fill(r[`${p}.step.${view.step_id}.data_description.${f.name}`])
        if (f.options) {
          const labels: Record<string, string> = {}
          for (const o of f.options) {
            const t = r[`${p}.step.${view.step_id}.data.${f.name}.options.${o}`] ?? r[`component.${view.handler}.selector.${f.name}.options.${o}`]
            if (t) labels[o] = t
          }
          if (Object.keys(labels).length) f.option_labels = labels
        }
      }
    }
    if (view.errors) view.errors_text = Object.values(view.errors).map(c => fill(r[`${p}.error.${c}`]) ?? c)
    if (view.type === 'abort' && view.reason) view.abort_text = fill(r[`${p}.abort.${view.reason}`]) ?? view.reason
  } catch {}
  return view
}

/** Flatten HA's raw config-flow result into what a form UI needs: one field
 *  list with types/required/options, plus step + error state. */
export function normalizeFlowResult(raw: any): FlowView {
  const type = (['form', 'create_entry', 'abort'].includes(raw?.type) ? raw.type : 'unknown') as FlowView['type']
  const view: FlowView = { type, flow_id: raw?.flow_id, handler: raw?.handler, step_id: raw?.step_id }
  if (raw?.title) view.title = String(raw.title)
  if (raw?.reason) view.reason = String(raw.reason)
  if (raw?.errors && Object.keys(raw.errors).length) view.errors = raw.errors
  if (raw?.description_placeholders && Object.keys(raw.description_placeholders).length) view.placeholders = raw.description_placeholders
  if (type === 'form') {
    // 'expandable'/'section' are schema groupings (advanced options), not
    // inputs — HA applies their defaults when omitted, so don't render them.
    view.fields = (raw.data_schema || []).filter((f: any) => f?.name && !['expandable', 'section', 'constant'].includes(f.type)).map((f: any) => {
      const field: FlowField = { name: String(f.name), type: String(f.type || 'string'), required: !!f.required }
      const opts = f.selector && typeof f.selector === 'object' ? f.selector.select?.options : undefined
      if (Array.isArray(opts)) field.options = opts.map((o: any) => String(typeof o === 'object' ? o.value : o))
      return field
    })
  }
  return view
}

export interface HaArea { area_id: string; name: string }
export interface HaRegistryEntry {
  entity_id: string
  area_id: string | null
  name: string | null
  hidden_by: string | null
  /** 'config' | 'diagnostic' | null — HA's own controls-vs-plumbing split. */
  entity_category: string | null
  /** Which integration provides this entity (e.g. 'sonos', 'cast'). */
  platform: string | null
  device_id: string | null
}

export async function haAreas(): Promise<HaArea[]> {
  const r = (await haWsCommand('config/area_registry/list')) as any[]
  return r.map(a => ({ area_id: a.area_id, name: a.name }))
}

export async function haCreateArea(name: string): Promise<HaArea> {
  const a = (await haWsCommand('config/area_registry/create', { name })) as any
  return { area_id: a.area_id, name: a.name }
}

/** device_id → area_id from the device registry (entities inherit this). */
export async function haDeviceAreas(): Promise<Map<string, string>> {
  const r = (await haWsCommand('config/device_registry/list')) as any[]
  const out = new Map<string, string>()
  for (const d of r) if (d.id && d.area_id) out.set(d.id, d.area_id)
  return out
}

/** device_id → manufacturer, for platform-agnostic brand detection
 * (a Ring camera arrives as platform 'ring' via cloud or 'mqtt' via
 * ring-mqtt discovery — the device manufacturer says "Ring" either way). */
export async function haDeviceManufacturers(): Promise<Map<string, string>> {
  const r = (await haWsCommand('config/device_registry/list')) as any[]
  const out = new Map<string, string>()
  for (const d of r) if (d.id && d.manufacturer) out.set(d.id, String(d.manufacturer))
  return out
}

export async function haEntityRegistry(): Promise<HaRegistryEntry[]> {
  const r = (await haWsCommand('config/entity_registry/list')) as any[]
  return r.map(e => ({
    entity_id: e.entity_id, area_id: e.area_id ?? null, name: e.name ?? null,
    hidden_by: e.hidden_by ?? null, entity_category: e.entity_category ?? null,
    platform: e.platform ?? null, device_id: e.device_id ?? null,
  }))
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

/**
 * Join area names onto entities AND drop the plumbing: entities HA marks as
 * config/diagnostic (a Sonos speaker alone sprays bass/treble/crossfade
 * accessory entities) and entities hidden in the registry. This is what keeps
 * orb's surfaces clean while HA stays the full-detail backend.
 */
export async function haJoinAreas(entities: HaEntity[]): Promise<HaEntity[]> {
  try {
    const [areas, reg, devs] = await Promise.all([haAreas(), haEntityRegistry(), haDeviceAreas()])
    const areaName = new Map(areas.map(a => [a.area_id, a.name]))
    const byId = new Map(reg.map(r => [r.entity_id, r]))
    // HA-internal platforms whose entities are system state, not the home.
    const INTERNAL = new Set(['backup', 'sun', 'analytics', 'hassio', 'update', 'person', 'zone', 'schedule', 'tod'])
    const kept: HaEntity[] = []
    for (const e of entities) {
      const r = byId.get(e.entity_id)
      if (r?.entity_category || r?.hidden_by) continue
      if (r?.platform && INTERNAL.has(r.platform)) continue
      // Entities inherit their area from the parent device unless overridden.
      const areaId = r?.area_id ?? (r?.device_id ? devs.get(r.device_id) : null)
      if (areaId && areaName.has(areaId)) e.area = areaName.get(areaId)
      kept.push(e)
    }
    return kept
  } catch { return entities /* registry unreachable → show everything */ }
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
