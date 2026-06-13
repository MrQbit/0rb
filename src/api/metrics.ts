/**
 * Tiny Prometheus exposition format emitter.
 *
 * Counters / gauges:
 *   orb2_chat_requests_total{model,outcome}
 *   orb2_active_streams
 *   orb2_tool_invocations_total{tool}
 *   orb2_token_usage_total{kind,model}
 *   orb2_http_requests_total{route,status}
 *   orb2_http_request_duration_seconds_sum{route}
 *   orb2_http_request_duration_seconds_count{route}
 *
 * Latency reservoirs (bounded sliding window, p50/p95/p99 derived):
 *   orb2_tool_duration_seconds{tool,quantile}
 *   orb2_turn_duration_seconds{model,quantile}
 *
 * No prom-client dep — rendering a flat text/plain document by hand
 * keeps deps (and the compiled binary) small.
 */
type Counter = Map<string, number>

const counters: Record<string, Counter> = {
  orb2_chat_requests_total: new Map(),
  orb2_tool_invocations_total: new Map(),
  orb2_token_usage_total: new Map(),
  orb2_http_requests_total: new Map(),
  orb2_http_request_duration_seconds_sum: new Map(),
  orb2_http_request_duration_seconds_count: new Map(),
}

let activeStreams = 0

// ─── Latency reservoirs ───
// Per-label sliding-window samples used to compute quantiles cheaply
// without pulling in a histogram lib. The window is bounded so memory
// stays flat under load; oldest sample is dropped on overflow.
const RESERVOIR_SIZE = 500

type Reservoir = {
  samples: number[]
  total: number
  count: number
}

const toolDurations = new Map<string, Reservoir>() // key = tool name
const turnDurations = new Map<string, Reservoir>() // key = model

function pushReservoir(map: Map<string, Reservoir>, key: string, ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return
  let r = map.get(key)
  if (!r) {
    r = { samples: [], total: 0, count: 0 }
    map.set(key, r)
  }
  r.samples.push(ms)
  if (r.samples.length > RESERVOIR_SIZE) r.samples.shift()
  r.total += ms
  r.count += 1
}

function quantile(samples: number[], q: number): number {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(q * sorted.length)),
  )
  return sorted[idx] ?? 0
}

function reservoirSnapshot(map: Map<string, Reservoir>) {
  const out: Record<string, {
    count: number
    avg_ms: number
    p50_ms: number
    p95_ms: number
    p99_ms: number
    max_ms: number
  }> = {}
  for (const [k, r] of map.entries()) {
    if (r.count === 0) continue
    const p50 = quantile(r.samples, 0.5)
    const p95 = quantile(r.samples, 0.95)
    const p99 = quantile(r.samples, 0.99)
    const max = r.samples.reduce((a, b) => (b > a ? b : a), 0)
    out[k] = {
      count: r.count,
      avg_ms: r.count > 0 ? Math.round(r.total / r.count) : 0,
      p50_ms: Math.round(p50),
      p95_ms: Math.round(p95),
      p99_ms: Math.round(p99),
      max_ms: Math.round(max),
    }
  }
  return out
}

function labelKey(labels: Record<string, string>): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(',')
}

function escapeLabelValue(v: string) {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function inc(name: keyof typeof counters, labels: Record<string, string>, by = 1) {
  const k = labelKey(labels)
  const m = counters[name]!
  m.set(k, (m.get(k) ?? 0) + by)
}

function add(name: keyof typeof counters, labels: Record<string, string>, by: number) {
  inc(name, labels, by)
}

export type MetricsSnapshot = {
  active_streams: number
  chat: Record<string, number>           // labelKey -> count
  tools: Record<string, number>          // tool -> invocation count
  tokens: Record<string, number>         // labelKey -> count
  http: Record<string, number>           // labelKey -> count
  tool_latency_ms: ReturnType<typeof reservoirSnapshot>
  turn_latency_ms: ReturnType<typeof reservoirSnapshot>
}

export const metrics = {
  recordChat(model: string, outcome: 'success' | 'error' | 'cancelled') {
    inc('orb2_chat_requests_total', { model: model || 'default', outcome })
  },
  recordTool(tool: string) {
    inc('orb2_tool_invocations_total', { tool })
  },
  recordToolDuration(tool: string, durationMs: number) {
    pushReservoir(toolDurations, tool || 'unknown', durationMs)
  },
  recordTurnDuration(model: string, durationMs: number) {
    pushReservoir(turnDurations, model || 'default', durationMs)
  },
  recordTokens(kind: 'input' | 'output', model: string, count: number) {
    if (count <= 0) return
    add('orb2_token_usage_total', { kind, model: model || 'default' }, count)
  },
  recordHttp(route: string, status: number, durationSeconds: number) {
    inc('orb2_http_requests_total', {
      route,
      status: String(status),
    })
    add('orb2_http_request_duration_seconds_sum', { route }, durationSeconds)
    inc('orb2_http_request_duration_seconds_count', { route })
  },
  streamOpened() {
    activeStreams++
  },
  streamClosed() {
    activeStreams = Math.max(0, activeStreams - 1)
  },
  activeStreams() {
    return activeStreams
  },
  snapshot(): MetricsSnapshot {
    const out: MetricsSnapshot = {
      active_streams: activeStreams,
      chat: Object.fromEntries(counters.orb2_chat_requests_total!.entries()),
      tools: {},
      tokens: Object.fromEntries(counters.orb2_token_usage_total!.entries()),
      http: Object.fromEntries(counters.orb2_http_requests_total!.entries()),
      tool_latency_ms: reservoirSnapshot(toolDurations),
      turn_latency_ms: reservoirSnapshot(turnDurations),
    }
    for (const [k, v] of counters.orb2_tool_invocations_total!.entries()) {
      // k looks like  tool="FileRead"
      const m = /tool="([^"]+)"/.exec(k)
      if (m) out.tools[m[1]!] = v
    }
    return out
  },
  render(): string {
    const lines: string[] = []
    const HELP: Record<string, [string, string]> = {
      orb2_chat_requests_total: [
        'Number of chat requests handled, partitioned by model and outcome.',
        'counter',
      ],
      orb2_tool_invocations_total: [
        'Number of agent tool invocations, partitioned by tool name.',
        'counter',
      ],
      orb2_token_usage_total: [
        'Cumulative token usage, partitioned by kind (input/output) and model.',
        'counter',
      ],
      orb2_http_requests_total: [
        'Number of HTTP requests served, partitioned by route and status code.',
        'counter',
      ],
      orb2_http_request_duration_seconds_sum: [
        'Cumulative HTTP request duration in seconds, partitioned by route.',
        'counter',
      ],
      orb2_http_request_duration_seconds_count: [
        'Number of HTTP request duration observations, partitioned by route.',
        'counter',
      ],
    }
    for (const [name, m] of Object.entries(counters)) {
      const [help, type] = HELP[name] ?? ['', 'counter']
      if (help) lines.push(`# HELP ${name} ${help}`)
      lines.push(`# TYPE ${name} ${type}`)
      for (const [labels, value] of m.entries()) {
        if (labels) {
          lines.push(`${name}{${labels}} ${value}`)
        } else {
          lines.push(`${name} ${value}`)
        }
      }
    }
    lines.push('# HELP orb2_active_streams Number of in-flight chat streams.')
    lines.push('# TYPE orb2_active_streams gauge')
    lines.push(`orb2_active_streams ${activeStreams}`)

    // ─── Latency summaries ───
    const renderSummary = (
      name: string,
      help: string,
      labelName: string,
      map: Map<string, Reservoir>,
    ) => {
      lines.push(`# HELP ${name} ${help}`)
      lines.push(`# TYPE ${name} summary`)
      for (const [key, r] of map.entries()) {
        if (r.count === 0) continue
        const lk = escapeLabelValue(key)
        const p50 = quantile(r.samples, 0.5) / 1000
        const p95 = quantile(r.samples, 0.95) / 1000
        const p99 = quantile(r.samples, 0.99) / 1000
        lines.push(`${name}{${labelName}="${lk}",quantile="0.5"} ${p50}`)
        lines.push(`${name}{${labelName}="${lk}",quantile="0.95"} ${p95}`)
        lines.push(`${name}{${labelName}="${lk}",quantile="0.99"} ${p99}`)
        lines.push(`${name}_sum{${labelName}="${lk}"} ${r.total / 1000}`)
        lines.push(`${name}_count{${labelName}="${lk}"} ${r.count}`)
      }
    }
    renderSummary(
      'orb2_tool_duration_seconds',
      'Tool invocation duration in seconds, partitioned by tool.',
      'tool',
      toolDurations,
    )
    renderSummary(
      'orb2_turn_duration_seconds',
      'Chat turn duration in seconds, partitioned by model.',
      'model',
      turnDurations,
    )
    return lines.join('\n') + '\n'
  },
}
