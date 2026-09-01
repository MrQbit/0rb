/**
 * Digital-twin REST (SPEC §18).
 *   GET  /v1/twin                 → plan + live room signals (+ my share flag)
 *   POST /v1/twin/seed            → (re)seed from HA areas — owner
 *   PUT  /v1/twin/room/<id>       → {name?, floor?} — owner
 *   PUT  /v1/twin/place           → {id, room} move a device — owner
 *   PUT  /v1/twin/share           → {on} — SELF ONLY (consent is personal)
 *   POST /v1/twin/location        → {geohash} app-reported, needs own opt-in
 */
import type { Store } from '../store/store.js'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

export async function tryHandleTwinRoute(method: string, pathname: string, req: Request, store: Store, user: string): Promise<Response | null> {
  if (!pathname.startsWith('/v1/twin')) return null
  const { getPlan, savePlan, seedFromHa } = await import('./model.js')
  const { currentRooms, getShare, setShare, reportLocation } = await import('./presence.js')
  const { isOwner } = await import('../auth/otp.js')
  const owner = user ? await isOwner(store, user).catch(() => false) : false

  if (method === 'GET' && pathname === '/v1/twin') {
    const plan = await getPlan(store)
    return jsonResponse(200, {
      plan,
      rooms_live: await currentRooms(store),
      my_share: user ? await getShare(store, user) : false,
    })
  }
  if (method === 'POST' && pathname === '/v1/twin/seed') {
    if (!owner) return jsonResponse(403, { error: 'owner only' })
    return jsonResponse(200, { plan: await seedFromHa(store) })
  }
  const rm = pathname.match(/^\/v1\/twin\/room\/([a-z0-9-]+)$/)
  if (method === 'PUT' && rm) {
    if (!owner) return jsonResponse(403, { error: 'owner only' })
    const b = await req.json().catch(() => ({})) as any
    const plan = await getPlan(store)
    const room = plan.rooms.find(r => r.id === rm[1])
    if (!room) return jsonResponse(404, { error: 'no such room' })
    if (typeof b.name === 'string' && b.name.trim()) room.name = b.name.trim()
    if (typeof b.floor === 'string' && b.floor.trim()) {
      room.floor = b.floor.trim()
      if (!plan.floors.includes(room.floor)) plan.floors.push(room.floor)
    }
    await savePlan(store, plan)
    return jsonResponse(200, { room })
  }
  if (method === 'PUT' && pathname === '/v1/twin/place') {
    if (!owner) return jsonResponse(403, { error: 'owner only' })
    const b = await req.json().catch(() => ({})) as any
    const id = String(b?.id || ''), roomId = String(b?.room || '')
    if (!id || !roomId) return jsonResponse(400, { error: 'id and room required' })
    const plan = await getPlan(store)
    if (!plan.rooms.some(r => r.id === roomId)) return jsonResponse(404, { error: 'no such room' })
    plan.placements[id] = roomId
    await savePlan(store, plan)
    return jsonResponse(200, { placed: id, room: roomId })
  }
  if (method === 'PUT' && pathname === '/v1/twin/share') {
    if (!user) return jsonResponse(401, { error: 'authentication required' })
    const b = await req.json().catch(() => ({})) as any
    const target = String(b?.member || user)
    // setShare re-checks; the route passes the SESSION user as actor so an
    // owner naming someone else is refused (consent is personal).
    const r = await setShare(store, user, target, b?.on === true)
    if (!r.ok) return jsonResponse(403, { error: r.error })
    return jsonResponse(200, { member: target, on: b?.on === true })
  }
  if (method === 'POST' && pathname === '/v1/twin/location') {
    if (!user) return jsonResponse(401, { error: 'authentication required' })
    const b = await req.json().catch(() => ({})) as any
    const r = await reportLocation(store, user, String(b?.geohash || ''))
    if (!r.ok) return jsonResponse(403, { error: r.error })
    return jsonResponse(200, { ok: true })
  }
  return null
}
