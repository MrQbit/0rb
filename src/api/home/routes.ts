/**
 * Home REST endpoints — let the Home dashboard widget refresh and control
 * devices directly (tap a light to toggle it) without a chat turn, the same
 * way the agent does through the Home tool.
 *
 *   GET  /v1/home/devices            → current devices (for the widget)
 *   POST /v1/home/control            → { entity_id, action, value? } → call HA
 */
import { haEnabled, haStates, haCallService, HOME_DOMAINS, haJoinAreas, toDeviceCard } from '../connectors/homeAssistant.js'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
async function readJson(req: Request): Promise<any> {
  try { return await req.json() } catch { return {} }
}

/** Pick the HA service for a tap/toggle-style action on an entity domain. */
function serviceFor(domain: string, action: string, value?: number): { service: string; data: Record<string, any> } | null {
  switch (domain) {
    case 'light':
      if (action === 'toggle') return { service: 'toggle', data: {} }
      if (action === 'on') return { service: 'turn_on', data: value != null ? { brightness_pct: value } : {} }
      if (action === 'off') return { service: 'turn_off', data: {} }
      if (action === 'set' && value != null) return { service: 'turn_on', data: { brightness_pct: value } }
      return null
    case 'switch':
    case 'fan':
      if (action === 'toggle') return { service: 'toggle', data: {} }
      if (action === 'on') return { service: 'turn_on', data: {} }
      if (action === 'off') return { service: 'turn_off', data: {} }
      return null
    case 'lock':
      if (action === 'toggle' || action === 'lock') return { service: 'lock', data: {} }
      if (action === 'unlock') return { service: 'unlock', data: {} }
      return null
    case 'cover':
      if (action === 'toggle') return { service: 'toggle', data: {} }
      if (action === 'open') return { service: 'open_cover', data: {} }
      if (action === 'close') return { service: 'close_cover', data: {} }
      if (action === 'set' && value != null) return { service: 'set_cover_position', data: { position: value } }
      return null
    case 'media_player':
      if (action === 'toggle') return { service: 'media_play_pause', data: {} }
      if (action === 'play') return { service: 'media_play', data: {} }
      if (action === 'pause') return { service: 'media_pause', data: {} }
      if (action === 'next') return { service: 'media_next_track', data: {} }
      if (action === 'prev') return { service: 'media_previous_track', data: {} }
      if (action === 'on') return { service: 'turn_on', data: {} }
      if (action === 'off') return { service: 'turn_off', data: {} }
      if (action === 'set' && value != null) return { service: 'volume_set', data: { volume_level: Math.max(0, Math.min(1, value / 100)) } }
      return null
    case 'climate':
      if (action === 'set' && value != null) return { service: 'set_temperature', data: { temperature: value } }
      return null
    case 'vacuum':
      if (action === 'start') return { service: 'start', data: {} }
      if (action === 'stop') return { service: 'stop', data: {} }
      if (action === 'dock') return { service: 'return_to_base', data: {} }
      return null
    case 'scene':
      if (action === 'on' || action === 'toggle' || action === 'activate') return { service: 'turn_on', data: {} }
      return null
    default:
      return null
  }
}

export async function tryHandleHomeRoute(method: string, pathname: string, req: Request): Promise<Response | null> {
  if (!pathname.startsWith('/v1/home')) return null
  if (!haEnabled()) return jsonResponse(503, { error: 'Home Assistant not configured', code: 'HA_DISABLED' })

  // Media artwork etc. — entity_picture paths are relative to HA and need
  // its auth; proxy them so the console (incl. remote/tailnet) can render.
  if (method === 'GET' && pathname === '/v1/home/ha-image') {
    const p = new URL(req.url).searchParams.get('path') || ''
    if (!p.startsWith('/')) return jsonResponse(400, { error: 'bad path' })
    try {
      const base = (process.env.ORB2_HA_URL || '').replace(/\/+$/, '')
      const r = await fetch(`${base}${p}`, { headers: { Authorization: `Bearer ${process.env.ORB2_HA_TOKEN || ''}` } })
      if (!r.ok) return jsonResponse(502, { error: `HA ${r.status}` })
      return new Response(r.body, { status: 200, headers: { 'content-type': r.headers.get('content-type') || 'image/jpeg', 'cache-control': 'private, max-age=30' } })
    } catch (e) { return jsonResponse(502, { error: (e as Error).message }) }
  }
  if (method === 'GET' && pathname === '/v1/home/devices') {
    try {
      const all = await haJoinAreas(await haStates(HOME_DOMAINS))
      return jsonResponse(200, { devices: all.map(toDeviceCard) })
    } catch (e) {
      return jsonResponse(502, { error: (e as Error).message })
    }
  }

  if (method === 'POST' && pathname === '/v1/home/control') {
    const body = await readJson(req)
    const entityId = String(body?.entity_id || '')
    const action = String(body?.action || 'toggle')
    const value = typeof body?.value === 'number' ? body.value : undefined
    if (!entityId) return jsonResponse(400, { error: 'entity_id required' })
    const domain = entityId.split('.')[0] || ''
    const plan = serviceFor(domain, action, value)
    if (!plan) return jsonResponse(400, { error: `cannot ${action} a ${domain}` })
    try {
      await haCallService(domain, plan.service, entityId, plan.data)
      return jsonResponse(200, { ok: true, entity_id: entityId, action })
    } catch (e) {
      return jsonResponse(502, { error: (e as Error).message })
    }
  }

  return null
}
