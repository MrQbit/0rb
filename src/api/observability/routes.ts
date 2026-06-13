/**
 * Observability + control endpoints (Phase 4).
 *
 * Stream control:
 *   DELETE /v1/chat/stream/:turnId   set abort flag for an in-flight turn
 *   GET    /v1/turns/:id/events      best-effort tail of the worker event mirror
 *
 * Turn / audit observability:
 *   GET /v1/turns/recent?limit=N            recent chat turns from audit
 *   GET /v1/audit/by-session?session_id=X   filtered audit slice
 */
import type { Store } from '../store/store.js'
import type { CallerIdentity } from '../auth/context.js'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const STREAM_ABORT_PREFIX = 'rak00n:stream:abort:'
const WORKER_STATE_PREFIX = 'rak00n:worker:'

export async function markTurnAborted(store: Store, turnId: string): Promise<void> {
  await store.putKv(STREAM_ABORT_PREFIX + turnId, '1', 600)
}

export async function isTurnAborted(store: Store, turnId: string): Promise<boolean> {
  return (await store.getKv(STREAM_ABORT_PREFIX + turnId)) === '1'
}

export async function tryHandleObservabilityRoute(
  req: Request,
  pathname: string,
  identity: CallerIdentity,
  ctx: { store: Store },
  isAdmin: (id: CallerIdentity) => boolean,
): Promise<Response | null> {
  const method = req.method
  const url = new URL(req.url)

  const abortMatch = pathname.match(/^\/v1\/chat\/stream\/([^/]+)$/)
  if (abortMatch && method === 'DELETE') {
    const turnId = abortMatch[1]!
    await markTurnAborted(ctx.store, turnId)
    return jsonResponse(200, { ok: true, turn_id: turnId, status: 'aborting' })
  }

  const turnEventsMatch = pathname.match(/^\/v1\/turns\/([^/]+)\/events$/)
  if (turnEventsMatch && method === 'GET') {
    const turnId = turnEventsMatch[1]!
    const stateRaw = await ctx.store.getKv(WORKER_STATE_PREFIX + turnId)
    let state: unknown = null
    if (stateRaw) { try { state = JSON.parse(stateRaw) } catch { state = stateRaw } }
    return jsonResponse(200, {
      turn_id: turnId,
      state,
      note: 'Live SSE events are consumed by the originating /v1/chat/stream call. The mirror only carries the terminal frame.',
    })
  }

  if (method === 'GET' && pathname === '/v1/turns/recent') {
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10) || 50))
    const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10)
    const events = await ctx.store.tailAudit(date, limit * 4)
    const turns = events
      .filter(e => e.event === 'chat.completed')
      .slice(-limit)
      .map(e => ({
        timestamp: (e as any).timestamp ?? null,
        session_id: (e as any).data?.session_id,
        latency_ms: (e as any).latencyMs,
        prompt_tokens: (e as any).data?.prompt_tokens,
        completion_tokens: (e as any).data?.completion_tokens,
        streaming: (e as any).data?.streaming === true,
      }))
    return jsonResponse(200, { turns })
  }

  if (method === 'GET' && pathname === '/v1/audit/by-session') {
    const sessionId = url.searchParams.get('session_id')
    if (!sessionId) return jsonResponse(400, { error: 'session_id required' })
    const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10)
    const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10) || 200))
    const events = await ctx.store.tailAudit(date, 5000)
    const filtered = events
      .filter(e => (e as any).data?.session_id === sessionId)
      .slice(-limit)
    return jsonResponse(200, { date, session_id: sessionId, events: filtered })
  }

  return null
}
