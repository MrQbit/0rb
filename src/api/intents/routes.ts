/**
 * Standing-intents REST surface (SPEC §15) — the Settings panel's window
 * into what the agent is quietly working on, per the trust rule that no
 * background activity is ever invisible.
 *
 *   GET    /v1/intents           → my watches (owner: everyone's)
 *   PATCH  /v1/intents/<id>      → { status: 'paused'|'active' }  (owner or the watch's member)
 *   DELETE /v1/intents/<id>      → cancel
 */
import type { Store } from '../store/store.js'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

export async function tryHandleIntentsRoute(method: string, pathname: string, req: Request, store: Store, user: string): Promise<Response | null> {
  if (!pathname.startsWith('/v1/intents')) return null
  const { listIntents, updateIntent, removeIntent } = await import('./engine.js')
  const { isOwner } = await import('../auth/otp.js')
  const owner = user ? await isOwner(store, user).catch(() => false) : false

  if (method === 'GET' && pathname === '/v1/intents') {
    const all = await listIntents(store)
    const visible = owner ? all : all.filter(i => i.member === user)
    return jsonResponse(200, { intents: visible.sort((a, b) => b.next_at - a.next_at) })
  }

  const m = pathname.match(/^\/v1\/intents\/(in-[a-z0-9-]+)$/)
  if (!m) return null
  const all = await listIntents(store)
  const it = all.find(i => i.id === m[1])
  if (!it) return jsonResponse(404, { error: 'no such watch' })
  if (!owner && it.member !== user) return jsonResponse(403, { error: 'not your watch' })

  if (method === 'PATCH') {
    const b = await req.json().catch(() => ({})) as any
    const status = String(b?.status || '')
    if (!['active', 'paused'].includes(status)) return jsonResponse(400, { error: 'status must be active|paused' })
    const patch: any = { status }
    if (status === 'active') patch.next_at = Date.now()
    return jsonResponse(200, { intent: await updateIntent(store, it.id, patch) })
  }
  if (method === 'DELETE') {
    await removeIntent(store, it.id)
    return jsonResponse(200, { removed: it.id })
  }
  return null
}
