/**
 * Topic-policy HTTP routes (admin-only).
 *
 *   GET    /v1/policies/topics             — current policy doc
 *   PUT    /v1/policies/topics             — replace whole doc
 *   POST   /v1/policies/topics/rules       — add a rule
 *   PATCH  /v1/policies/topics/rules/{id}  — edit a rule
 *   DELETE /v1/policies/topics/rules/{id}  — delete a rule
 *   POST   /v1/policies/topics/test        — dry-run classification
 */
import type { Store } from '../store/store.js'
import type { CallerIdentity } from '../auth/context.js'
import {
  loadPolicy,
  savePolicy,
  sanitizePolicy,
  addRule,
  patchRule,
  deleteRule,
} from './topicPolicy.js'
import { clearTopicPolicyCache, evaluateTopicPolicy } from './evaluate.js'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function actorOf(identity: CallerIdentity | null): string | undefined {
  if (!identity) return undefined
  if (identity.type === 'apikey') return identity.record.id
  if (identity.type === 'service') return identity.agentId
  return undefined
}

export async function tryHandlePolicyRoute(
  req: Request,
  pathname: string,
  identity: CallerIdentity | null,
  ctx: { store: Store; audit?: (e: any) => void },
): Promise<Response | null> {
  if (!pathname.startsWith('/v1/policies/topics')) return null
  const method = req.method
  const actor = actorOf(identity)

  if (method === 'GET' && pathname === '/v1/policies/topics') {
    const policy = await loadPolicy(ctx.store)
    return jsonResponse(200, { policy })
  }

  if (method === 'PUT' && pathname === '/v1/policies/topics') {
    let body: any
    try { body = await req.json() } catch { return jsonResponse(400, { error: 'invalid JSON body' }) }
    const current = await loadPolicy(ctx.store)
    let next
    try { next = sanitizePolicy(body || {}, current) }
    catch (err) { return jsonResponse(400, { error: (err as Error).message }) }
    const saved = await savePolicy(ctx.store, next, actor)
    clearTopicPolicyCache()
    ctx.audit?.({ event: 'policy.updated', data: { version: saved.version, mode: saved.mode, rules: saved.rules.length } })
    return jsonResponse(200, { policy: saved })
  }

  if (method === 'POST' && pathname === '/v1/policies/topics/test') {
    let body: any
    try { body = await req.json() } catch { return jsonResponse(400, { error: 'invalid JSON body' }) }
    const message = typeof body?.message === 'string' ? body.message : ''
    if (!message) return jsonResponse(400, { error: 'message is required' })
    const policy = await loadPolicy(ctx.store)
    const result = await evaluateTopicPolicy({ message, policy })
    return jsonResponse(200, {
      matched: result.matched.map(r => ({ id: r.id, topic: r.topic })),
      classifier: result.classifier,
      rider: result.rider,
      mode: policy.mode,
    })
  }

  if (method === 'POST' && pathname === '/v1/policies/topics/rules') {
    let body: any
    try { body = await req.json() } catch { return jsonResponse(400, { error: 'invalid JSON body' }) }
    try {
      const saved = await addRule(ctx.store, body || {}, actor)
      clearTopicPolicyCache()
      ctx.audit?.({ event: 'policy.rule.added', data: { rule: body?.topic, version: saved.version } })
      return jsonResponse(201, { policy: saved })
    } catch (err) {
      return jsonResponse(400, { error: (err as Error).message })
    }
  }

  const named = pathname.match(/^\/v1\/policies\/topics\/rules\/([a-z0-9_-]{1,32})$/i)
  if (named) {
    const id = named[1]!
    if (method === 'DELETE') {
      const saved = await deleteRule(ctx.store, id, actor)
      if (!saved) return jsonResponse(404, { error: 'rule not found' })
      clearTopicPolicyCache()
      ctx.audit?.({ event: 'policy.rule.deleted', data: { rule_id: id, version: saved.version } })
      return jsonResponse(200, { policy: saved })
    }
    if (method === 'PATCH') {
      let body: any
      try { body = await req.json() } catch { return jsonResponse(400, { error: 'invalid JSON body' }) }
      try {
        const saved = await patchRule(ctx.store, id, body || {}, actor)
        if (!saved) return jsonResponse(404, { error: 'rule not found' })
        clearTopicPolicyCache()
        ctx.audit?.({ event: 'policy.rule.updated', data: { rule_id: id, version: saved.version } })
        return jsonResponse(200, { policy: saved })
      } catch (err) {
        return jsonResponse(400, { error: (err as Error).message })
      }
    }
  }

  return null
}
