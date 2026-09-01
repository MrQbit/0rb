/**
 * Hybrid-brain REST (SPEC §17) — the "What leaves the box" Settings card.
 *   GET /v1/brain → config + keyed provider + month spend (any member: the
 *                   household deserves to SEE the policy)
 *   PUT /v1/brain → owner-only changes (master, classes, cap, model)
 */
import type { Store } from '../store/store.js'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

export async function tryHandleBrainRoute(method: string, pathname: string, req: Request, store: Store, user: string): Promise<Response | null> {
  if (pathname !== '/v1/brain') return null
  const { getBrainConfig, setBrainConfig, getMonthSpendCents, cloudProvider } = await import('./policy.js')

  if (method === 'GET') {
    const cfg = await getBrainConfig(store)
    const provider = cloudProvider(cfg.model)
    return jsonResponse(200, {
      ...cfg,
      keyed: !!provider,
      provider_model: provider?.model || null,
      month_spend_cents: Math.round(await getMonthSpendCents(store)),
    })
  }
  if (method === 'PUT') {
    const { isOwner } = await import('../auth/otp.js')
    if (!user || !(await isOwner(store, user))) return jsonResponse(403, { error: 'owner only' })
    const b = await req.json().catch(() => ({})) as any
    const next = await setBrainConfig(store, {
      enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
      classes: (b.classes && typeof b.classes === 'object') ? b.classes : undefined,
      monthly_cap_cents: typeof b.monthly_cap_cents === 'number' ? b.monthly_cap_cents : undefined,
      model: typeof b.model === 'string' ? b.model : undefined,
    })
    return jsonResponse(200, next)
  }
  return null
}
