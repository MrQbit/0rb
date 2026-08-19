/**
 * Endpoints for the Matter bridge sidecar (services/matter): a compact
 * snapshot of what the bridge exposes into Apple Home, control callbacks,
 * and a session-authed proxy so Settings can show the pairing code.
 *
 *   GET  /v1/matter/snapshot   (sidecar, token) lights/switches + mode + people
 *   POST /v1/matter/control    (sidecar, token) { entity_id, action, value? }
 *   POST /v1/matter/mode       (sidecar, token) { away: boolean }
 *   GET  /v1/matter/pairing    (console session) proxies the sidecar
 *
 * Token: X-Matter-Token must equal ORB2_MATTER_TOKEN when set (same
 * LAN-internal convention as the bridge sidecar).
 */
import { haEnabled, haStates, haJoinAreas, haCallService } from '../connectors/homeAssistant.js'
import { serviceFor } from '../home/routes.js'
import type { Store } from '../store/store.js'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function sidecarAuthed(req: Request): boolean {
  const want = process.env.ORB2_MATTER_TOKEN || ''
  return !want || req.headers.get('x-matter-token') === want
}

function matterUrl(): string {
  return (process.env.ORB2_MATTER_URL || 'http://host.docker.internal:8998').replace(/\/+$/, '')
}

export async function tryHandleMatterRoute(method: string, pathname: string, req: Request, store: Store): Promise<Response | null> {
  if (!pathname.startsWith('/v1/matter/')) return null

  // Console-facing: pairing state for the Settings card (session-authed
  // upstream like every /v1 route; reaches the sidecar over the host gateway).
  if (method === 'GET' && pathname === '/v1/matter/pairing') {
    try {
      const r = await fetch(`${matterUrl()}/pairing`, { signal: AbortSignal.timeout(6000) })
      return json(200, { enabled: true, ...(await r.json() as any) })
    } catch {
      return json(200, { enabled: false })
    }
  }

  // Sidecar-facing routes below.
  if (!sidecarAuthed(req)) return json(401, { error: 'bad matter token' })

  if (method === 'GET' && pathname === '/v1/matter/snapshot') {
    if (!haEnabled()) return json(200, { devices: [], mode: 'home', people: [] })
    try {
      const [ents, people] = await Promise.all([
        haJoinAreas(await haStates(['light', 'switch'])),
        haStates(['person']).catch(() => []),
      ])
      const { getMode } = await import('../home/mode.js')
      return json(200, {
        devices: ents.map(e => ({
          entity_id: e.entity_id,
          name: e.name,
          area: e.area ?? null,
          domain: e.domain,
          on: e.state === 'on',
          brightness: e.domain === 'light' && typeof e.attributes.brightness === 'number' ? e.attributes.brightness : null,
        })),
        mode: await getMode(store),
        people: people.map(p => ({ name: p.name, home: p.state === 'home' })),
      })
    } catch (e) {
      return json(502, { error: (e as Error).message })
    }
  }

  if (method === 'POST' && pathname === '/v1/matter/control') {
    const b: any = await req.json().catch(() => ({}))
    const entityId = String(b?.entity_id || '')
    const action = String(b?.action || '')
    const value = typeof b?.value === 'number' ? b.value : undefined
    const domain = entityId.split('.')[0] || ''
    const plan = serviceFor(domain, action, value)
    if (!entityId || !plan) return json(400, { error: 'bad control' })
    try {
      await haCallService(domain, plan.service, entityId, plan.data)
      return json(200, { ok: true })
    } catch (e) {
      return json(502, { error: (e as Error).message })
    }
  }

  if (method === 'POST' && pathname === '/v1/matter/mode') {
    const b: any = await req.json().catch(() => ({}))
    const { setMode } = await import('../home/mode.js')
    await setMode(store, b?.away === true ? 'away' : 'home')
    return json(200, { ok: true })
  }

  return null
}
