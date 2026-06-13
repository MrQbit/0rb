/**
 * Builds the dashboard telemetry snapshot that the relay reporter
 * pushes every 60 seconds. The shape mirrors what the Console renders
 * client-side, so the relay sees exactly the same numbers the operator
 * sees locally — no synthetic counters, no shadow telemetry.
 *
 * Everything here is derived from data that already exists in Redis
 * or in the in-process metrics module; nothing new gets written by
 * this code path.
 */
import { metrics } from '../metrics.js'
import type { Store } from '../store/store.js'
import { dollars, type CostRecord } from '../cost/routes.js'
import { getDiscoveryState } from '../discovery/registry.js'
import { getRelayReporter, type DashboardSnapshot } from './reporter.js'

const COST_INDEX_KEY = 'orb2:cost:index'
const COST_KEY_PREFIX = 'orb2:cost:session:'
const COST_OWNER_PREFIX = 'orb2:cost:owner:'
const COST_OWNER_INDEX = 'orb2:cost:owners'

async function readJsonArray<T>(store: Store, key: string): Promise<T[]> {
  const raw = await store.getKv(key)
  try { return raw ? JSON.parse(raw) as T[] : [] } catch { return [] }
}

export type SnapshotInputs = {
  store: Store
  workerMode: string
  defaultModel?: string | null
  workerStats?: { active: number; total: number } | null
  redisOk?: boolean
  vaultOk?: boolean | null
}

export async function buildDashboardSnapshot(inputs: SnapshotInputs): Promise<DashboardSnapshot | null> {
  const reporter = getRelayReporter()
  const instanceId = reporter?.getInstanceId() ?? 'unknown'

  // ── Cost / sessions / users ──
  const sessionIds = await readJsonArray<string>(inputs.store, COST_INDEX_KEY)
  let promptTokens = 0
  let completionTokens = 0
  let usd = 0
  const byModel: Record<string, { model: string; prompt: number; completion: number; turns: number }> = {}
  for (const sid of sessionIds) {
    const recs = await readJsonArray<CostRecord>(inputs.store, COST_KEY_PREFIX + sid)
    for (const r of recs) {
      promptTokens += r.prompt_tokens
      completionTokens += r.completion_tokens
      usd += dollars(r.model, r.prompt_tokens, r.completion_tokens)
      const slot = byModel[r.model] ?? (byModel[r.model] = { model: r.model, prompt: 0, completion: 0, turns: 0 })
      slot.prompt += r.prompt_tokens
      slot.completion += r.completion_tokens
      slot.turns += 1
    }
  }

  const owners = await readJsonArray<string>(inputs.store, COST_OWNER_INDEX)
  const now = Date.now()
  const dayMs = 86_400_000
  let active24h = 0
  let active7d = 0
  const daySet: Record<string, Set<string>> = {}
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now - i * dayMs).toISOString().slice(0, 10)
    daySet[d] = new Set()
  }
  for (const oid of owners) {
    const recs = await readJsonArray<CostRecord>(inputs.store, COST_OWNER_PREFIX + oid)
    let in24 = false
    let in7d = false
    for (const r of recs) {
      const t = Date.parse(r.recorded_at || '')
      if (!Number.isFinite(t)) continue
      if (now - t <= dayMs) in24 = true
      if (now - t <= 7 * dayMs) in7d = true
      const day = r.recorded_at.slice(0, 10)
      if (daySet[day]) daySet[day]!.add(oid)
    }
    if (in24) active24h++
    if (in7d) active7d++
  }
  const dayCounts = Object.values(daySet).map(s => s.size)
  const weeklyAvg = dayCounts.length > 0
    ? Math.round((dayCounts.reduce((a, b) => a + b, 0) / dayCounts.length) * 10) / 10
    : 0

  // ── Metrics ──
  const snap = metrics.snapshot()
  const chat_outcomes: Record<string, number> = {}
  for (const [k, v] of Object.entries(snap.chat)) {
    const m = /outcome="([^"]+)"/.exec(k)
    if (!m) continue
    chat_outcomes[m[1]!] = (chat_outcomes[m[1]!] ?? 0) + v
  }
  const top_tools = Object.entries(snap.tools)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([tool, invocations]) => ({ tool, invocations }))

  // ── Discovery ──
  const disc = getDiscoveryState()
  const discovered_repos = disc.repos.map(r => ({
    source_repo: r.source_repo,
    kind: r.source.kind,
    ok: r.ok,
    counts: r.counts,
  }))

  return {
    instance_id: instanceId,
    at: new Date().toISOString(),
    health: {
      redis_ok: inputs.redisOk ?? true,
      vault_ok: inputs.vaultOk ?? null,
      active_streams: metrics.activeStreams(),
      worker_mode: inputs.workerMode,
      workers: inputs.workerStats ?? null,
      default_model: inputs.defaultModel ?? null,
    },
    sessions: { total: sessionIds.length },
    users: {
      all_time: owners.length,
      active_24h: active24h,
      active_7d: active7d,
      weekly_avg_per_day: weeklyAvg,
    },
    tokens: {
      prompt: promptTokens,
      completion: completionTokens,
      total: promptTokens + completionTokens,
      usd: Number(usd.toFixed(6)),
      by_model: Object.values(byModel),
    },
    chat_outcomes,
    top_tools,
    tool_latency_ms: snap.tool_latency_ms,
    turn_latency_ms: snap.turn_latency_ms,
    discovered_repos,
  }
}
