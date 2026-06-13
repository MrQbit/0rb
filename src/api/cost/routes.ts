/**
 * Cost / usage analytics endpoints.
 *
 * Per-turn token usage is recorded in Redis (key
 * `orb2:cost:session:<id>` -- a JSON-encoded array of records). The
 * total list is bounded; we keep the last 1000 records per session.
 *
 * Pricing: per-model $/Mtok rates from PRICING below. Override via
 * env vars `ORB2_PRICE_<MODEL>_INPUT` and `ORB2_PRICE_<MODEL>_OUTPUT`
 * (USD per million tokens). Unknown models fall back to the
 * `default` entry.
 *
 * Routes:
 *   GET /v1/cost                    aggregate cost across all sessions
 *   GET /v1/cost/sessions/:id       per-session cost detail
 *   GET /v1/usage                   token usage histogram by model
 */
import type { Store } from '../store/store.js'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const COST_KEY_PREFIX = 'orb2:cost:session:'
const COST_INDEX_KEY = 'orb2:cost:index'
const COST_OWNER_PREFIX = 'orb2:cost:owner:'
const COST_OWNER_INDEX = 'orb2:cost:owners'

export type CostRecord = {
  session_id: string
  model: string
  prompt_tokens: number
  completion_tokens: number
  duration_ms: number
  recorded_at: string
  owner_oid?: string
  owner_email?: string
  key_id?: string
  tenant_id?: string
}

const PRICING: Record<string, { input: number; output: number }> = {
  default: { input: 3.0, output: 15.0 },
  'claude-sonnet-4-5': { input: 3.0, output: 15.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
  'claude-opus-4-5': { input: 15.0, output: 75.0 },
}

function priceFor(model: string): { input: number; output: number } {
  const norm = model.toUpperCase().replace(/[^A-Z0-9]/g, '_')
  const envIn = process.env[`ORB2_PRICE_${norm}_INPUT`]
  const envOut = process.env[`ORB2_PRICE_${norm}_OUTPUT`]
  const base = PRICING[model] ?? PRICING.default
  return {
    input: envIn ? Number(envIn) : base.input,
    output: envOut ? Number(envOut) : base.output,
  }
}

export function dollars(model: string, prompt: number, completion: number): number {
  const p = priceFor(model)
  return (prompt * p.input + completion * p.output) / 1_000_000
}

export async function recordCostPoint(store: Store, point: CostRecord): Promise<void> {
  try {
    const key = COST_KEY_PREFIX + point.session_id
    const raw = await store.getKv(key)
    let arr: CostRecord[] = []
    try { arr = raw ? JSON.parse(raw) : [] } catch { arr = [] }
    arr.push(point)
    await store.putKv(key, JSON.stringify(arr.slice(-1000)), 86400 * 30)
    const idxRaw = await store.getKv(COST_INDEX_KEY)
    let idx: string[] = []
    try { idx = idxRaw ? JSON.parse(idxRaw) : [] } catch { idx = [] }
    if (!idx.includes(point.session_id)) {
      idx.push(point.session_id)
      await store.putKv(COST_INDEX_KEY, JSON.stringify(idx.slice(-1000)), 86400 * 30)
    }
    if (point.owner_oid) {
      const okey = COST_OWNER_PREFIX + point.owner_oid
      const oraw = await store.getKv(okey)
      let oarr: CostRecord[] = []
      try { oarr = oraw ? JSON.parse(oraw) : [] } catch { oarr = [] }
      oarr.push(point)
      await store.putKv(okey, JSON.stringify(oarr.slice(-2000)), 86400 * 60)
      const oidxRaw = await store.getKv(COST_OWNER_INDEX)
      let oidx: string[] = []
      try { oidx = oidxRaw ? JSON.parse(oidxRaw) : [] } catch { oidx = [] }
      if (!oidx.includes(point.owner_oid)) {
        oidx.push(point.owner_oid)
        await store.putKv(COST_OWNER_INDEX, JSON.stringify(oidx.slice(-2000)), 86400 * 60)
      }
    }
  } catch {
    // Best-effort -- never break the chat path because cost recording failed.
  }
}

async function readSession(store: Store, sessionId: string): Promise<CostRecord[]> {
  const raw = await store.getKv(COST_KEY_PREFIX + sessionId)
  try { return raw ? JSON.parse(raw) : [] } catch { return [] }
}

async function readOwner(store: Store, ownerOid: string): Promise<CostRecord[]> {
  const raw = await store.getKv(COST_OWNER_PREFIX + ownerOid)
  try { return raw ? JSON.parse(raw) : [] } catch { return [] }
}

async function listOwners(store: Store): Promise<string[]> {
  const raw = await store.getKv(COST_OWNER_INDEX)
  try { return raw ? JSON.parse(raw) : [] } catch { return [] }
}

function aggregate(records: CostRecord[]) {
  let promptTokens = 0
  let completionTokens = 0
  let usd = 0
  const byModel: Record<string, { prompt_tokens: number; completion_tokens: number; usd: number; turns: number }> = {}
  for (const r of records) {
    promptTokens += r.prompt_tokens
    completionTokens += r.completion_tokens
    const cost = dollars(r.model, r.prompt_tokens, r.completion_tokens)
    usd += cost
    const slot = byModel[r.model] ?? (byModel[r.model] = {
      prompt_tokens: 0, completion_tokens: 0, usd: 0, turns: 0,
    })
    slot.prompt_tokens += r.prompt_tokens
    slot.completion_tokens += r.completion_tokens
    slot.usd += cost
    slot.turns += 1
  }
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    usd: Number(usd.toFixed(6)),
    turns: records.length,
    by_model: Object.fromEntries(
      Object.entries(byModel).map(([m, v]) => [m, { ...v, usd: Number(v.usd.toFixed(6)) }]),
    ),
  }
}

export async function tryHandleCostRoute(
  req: Request,
  pathname: string,
  ctx: { store: Store },
): Promise<Response | null> {
  const method = req.method

  if (method === 'GET' && pathname === '/v1/cost') {
    const idxRaw = await ctx.store.getKv(COST_INDEX_KEY)
    let sessions: string[] = []
    try { sessions = idxRaw ? JSON.parse(idxRaw) : [] } catch { sessions = [] }
    const all: CostRecord[] = []
    for (const sid of sessions) all.push(...(await readSession(ctx.store, sid)))
    return jsonResponse(200, { total: aggregate(all), sessions: sessions.length })
  }

  const sesMatch = pathname.match(/^\/v1\/cost\/sessions\/([^/]+)$/)
  if (sesMatch && method === 'GET') {
    const sessionId = sesMatch[1]!
    const records = await readSession(ctx.store, sessionId)
    return jsonResponse(200, {
      session_id: sessionId,
      total: aggregate(records),
      records: records.slice(-100),
    })
  }

  if (method === 'GET' && pathname === '/v1/cost/users') {
    const owners = await listOwners(ctx.store)
    const now = Date.now()
    const dayMs = 86_400_000
    const dayKeys: string[] = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now - i * dayMs)
      dayKeys.push(d.toISOString().slice(0, 10))
    }
    const rows = await Promise.all(owners.map(async oid => {
      const records = await readOwner(ctx.store, oid)
      const agg = aggregate(records)
      const sessions = new Set(records.map(r => r.session_id))
      const email = records.find(r => r.owner_email)?.owner_email
      const tenant = records.find(r => r.tenant_id)?.tenant_id
      const recordsByDay: Record<string, number> = {}
      for (const k of dayKeys) recordsByDay[k] = 0
      let lastRecordedAt: string | null = null
      for (const r of records) {
        if (!lastRecordedAt || r.recorded_at > lastRecordedAt) lastRecordedAt = r.recorded_at
        const day = (r.recorded_at || '').slice(0, 10)
        if (day && recordsByDay[day] !== undefined) recordsByDay[day]! += 1
      }
      return {
        owner_oid: oid,
        owner_email: email ?? null,
        tenant_id: tenant ?? null,
        sessions: sessions.size,
        prompt_tokens: agg.prompt_tokens,
        completion_tokens: agg.completion_tokens,
        total_tokens: agg.total_tokens,
        usd: agg.usd,
        turns: agg.turns,
        by_model: agg.by_model,
        last_recorded_at: lastRecordedAt,
        records_by_day: recordsByDay,
      }
    }))
    rows.sort((a, b) => b.usd - a.usd)
    return jsonResponse(200, { users: rows, days: dayKeys })
  }

  const userMatch = pathname.match(/^\/v1\/cost\/users\/([^/]+)$/)
  if (userMatch && method === 'GET') {
    const ownerOid = decodeURIComponent(userMatch[1]!)
    const records = await readOwner(ctx.store, ownerOid)
    const sessions = new Set(records.map(r => r.session_id))
    return jsonResponse(200, {
      owner_oid: ownerOid,
      owner_email: records.find(r => r.owner_email)?.owner_email ?? null,
      tenant_id: records.find(r => r.tenant_id)?.tenant_id ?? null,
      sessions: Array.from(sessions),
      total: aggregate(records),
      records: records.slice(-200),
    })
  }

  if (method === 'GET' && pathname === '/v1/usage') {
    const idxRaw = await ctx.store.getKv(COST_INDEX_KEY)
    let sessions: string[] = []
    try { sessions = idxRaw ? JSON.parse(idxRaw) : [] } catch { sessions = [] }
    const all: CostRecord[] = []
    for (const sid of sessions) all.push(...(await readSession(ctx.store, sid)))
    const agg = aggregate(all)
    return jsonResponse(200, {
      total_tokens: agg.total_tokens,
      prompt_tokens: agg.prompt_tokens,
      completion_tokens: agg.completion_tokens,
      turns: agg.turns,
      models: Object.entries(agg.by_model).map(([model, v]) => ({
        model,
        prompt_tokens: v.prompt_tokens,
        completion_tokens: v.completion_tokens,
        turns: v.turns,
      })),
    })
  }

  return null
}
