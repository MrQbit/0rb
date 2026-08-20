/**
 * Home REST endpoints — let the Home dashboard widget refresh and control
 * devices directly (tap a light to toggle it) without a chat turn, the same
 * way the agent does through the Home tool.
 *
 *   GET  /v1/home/devices            → current devices (for the widget)
 *   POST /v1/home/control            → { entity_id, action, value? } → call HA
 */
import {
  haEnabled, haStates, haCallService, HOME_DOMAINS, haJoinAreas, toDeviceCard,
  haConfigEntries, haDiscoveredFlows, haFlowStart, haFlowAdvance, haFlowDismiss, normalizeFlowResult, translateFlowView, haIntegrationName,
} from '../connectors/homeAssistant.js'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
async function readJson(req: Request): Promise<any> {
  try { return await req.json() } catch { return {} }
}

/** Pick the HA service for a tap/toggle-style action on an entity domain. */
export function serviceFor(domain: string, action: string, value?: number): { service: string; data: Record<string, any> } | null {
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
    case 'button':
      if (action === 'press' || action === 'on' || action === 'toggle') return { service: 'press', data: {} }
      return null
    case 'automation':
      if (action === 'on') return { service: 'turn_on', data: {} }
      if (action === 'off') return { service: 'turn_off', data: {} }
      if (action === 'toggle') return { service: 'toggle', data: {} }
      if (action === 'run' || action === 'trigger') return { service: 'trigger', data: {} }
      return null
    default:
      return null
  }
}

export async function tryHandleHomeRoute(method: string, pathname: string, req: Request, store?: import('../store/store.js').Store): Promise<Response | null> {
  if (!pathname.startsWith('/v1/home')) return null

  // Settings → Smart home. Answers even when HA is unconfigured so the panel
  // can show "not connected" + the token hint instead of erroring.
  if (method === 'GET' && pathname === '/v1/home/integrations') {
    if (!haEnabled()) return jsonResponse(200, { configured: false, entries: [], discovered: [] })
    try {
      const [entries, discovered] = await Promise.all([haConfigEntries(), haDiscoveredFlows()])
      // HA's built-in plumbing (sun, analytics, backup…) isn't something the
      // user installed — hide it unless it's unhealthy and worth surfacing.
      const INTERNAL = new Set(['sun', 'analytics', 'backup', 'go2rtc', 'hassio', 'onboarding', 'hardware', 'usb',
        'shopping_list', 'google_translate', 'met', 'radio_browser', 'zone', 'person', 'update'])
      const visible = entries.filter(e => e.state !== 'loaded' || !INTERNAL.has(e.domain))
      // Direct-first policy, hard form: devices the LAN bridge already serves
      // (printers, AirPlay audio) are DISMISSED from HA's pending queue —
      // they work with zero setup, so a pending HA flow is pure duplicate
      // noise. HA re-discovers after restarts; we re-dismiss, cheaply.
      const { bridgeEnabled } = await import('../connectors/bridge.js')
      const COVERED = new Set(['ipp', 'brother', 'apple_tv'])
      let remaining = discovered
      if (bridgeEnabled()) {
        const scrub = discovered.filter(f => COVERED.has(f.handler))
        remaining = discovered.filter(f => !COVERED.has(f.handler))
        for (const f of scrub) haFlowDismiss(f.flow_id).catch(() => { /* best effort */ })
      }
      // Human names for what's left ("matter" → "Matter").
      const named = await Promise.all(remaining.map(async f => ({
        ...f, title: await haIntegrationName(f.handler),
      })))
      return jsonResponse(200, { configured: true, entries: visible, discovered: named })
    } catch (e) {
      return jsonResponse(200, { configured: true, reachable: false, error: (e as Error).message, entries: [], discovered: [] })
    }
  }

  if (!haEnabled()) return jsonResponse(503, { error: 'Home Assistant not configured', code: 'HA_DISABLED' })

  // Config-flow proxy — lets the Settings panel and the setup widget drive a
  // pairing flow (start → form fields → advance → create_entry) directly.
  if (method === 'POST' && pathname === '/v1/home/flow/start') {
    const b = await readJson(req)
    const handler = String(b?.handler || '').trim().toLowerCase()
    if (!/^[a-z0-9_]+$/.test(handler)) return jsonResponse(400, { error: 'handler must be an integration id, e.g. roomba' })
    try {
      const view = normalizeFlowResult(await haFlowStart(handler)); view.handler ||= handler
      return jsonResponse(200, { flow: await translateFlowView(view) })
    }
    catch (e) { return jsonResponse(502, { error: (e as Error).message }) }
  }
  const fm = pathname.match(/^\/v1\/home\/flow\/([A-Za-z0-9]+)$/)
  if (fm && method === 'GET') {
    const { haFlowStatus } = await import('../connectors/homeAssistant.js')
    try { return jsonResponse(200, { flow: await translateFlowView(normalizeFlowResult(await haFlowStatus(fm[1]!))) }) }
    catch (e) { return jsonResponse(502, { error: (e as Error).message }) }
  }
  if (fm && method === 'POST') {
    const b = await readJson(req)
    const data = (b?.data && typeof b.data === 'object') ? b.data : {}
    try { return jsonResponse(200, { flow: await translateFlowView(normalizeFlowResult(await haFlowAdvance(fm[1]!, data))) }) }
    catch (e) { return jsonResponse(502, { error: (e as Error).message }) }
  }
  if (fm && method === 'DELETE') {
    try { await haFlowDismiss(fm[1]!); return jsonResponse(200, { dismissed: fm[1] }) }
    catch (e) { return jsonResponse(502, { error: (e as Error).message }) }
  }

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
  if (pathname === '/v1/home/mode' && store) {
    const { getMode, setMode } = await import('./mode.js')
    if (method === 'GET') return jsonResponse(200, { mode: await getMode(store) })
    if (method === 'POST') {
      const b = await readJson(req)
      const m = String(b?.mode || '')
      if (!['home', 'away', 'vacation', 'guest'].includes(m)) return jsonResponse(400, { error: 'mode must be home|away|vacation|guest' })
      await setMode(store, m as any)
      return jsonResponse(200, { mode: m })
    }
  }
  const tdel = pathname.match(/^\/v1\/home\/timers\/(t-[a-z0-9-]+)$/)
  if (method === 'DELETE' && tdel && store) {
    const { cancelTimer, listTimers } = await import('./timers.js')
    const gone = await cancelTimer(store, tdel[1]!)
    if (!gone) return jsonResponse(404, { error: 'no such timer' })
    return jsonResponse(200, { removed: gone.id, remaining: await listTimers(store) })
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
    // TV input switching (string-valued, so outside serviceFor's numeric shape)
    if (domain === 'media_player' && action === 'source' && typeof body?.source === 'string' && body.source) {
      try {
        await haCallService(domain, 'select_source', entityId, { source: body.source })
        return jsonResponse(200, { ok: true, entity_id: entityId, action, source: body.source })
      } catch (e) { return jsonResponse(502, { error: (e as Error).message }) }
    }
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
