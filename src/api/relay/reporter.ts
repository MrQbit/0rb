/**
 * Relay Reporter — connects a RAK00N instance to the rak00n-relay federation.
 *
 * Phase 2 boot sequence:
 *   1. start() resolves a stable RAK00N_INSTANCE_ID (from env or Redis)
 *   2. register() POSTs the bootstrap shared secret to
 *      /v1/instances/register and persists the returned
 *      `instance_token` in Redis. Backoff retries (5s/30s/2m/10m/30m)
 *      keep trying forever — boot NEVER blocks on this call.
 *   3. Once a token is in hand every subsequent event uses
 *      Authorization: Bearer <token> alongside the (deprecated)
 *      X-Relay-Event-Secret header for backward compat.
 *   4. Heartbeats fire every 30s; queued usage/session events flush
 *      every 10s. All calls are fire-and-forget with a 5s timeout.
 *
 * Status (`getStatus()`) reflects the connection state so /v1/relay/status
 * can surface it for operators without affecting health probes.
 *
 * Each RAK00N instance gets a unique RAK00N_INSTANCE_ID (auto-generated
 * and persisted in Redis if not explicitly set via env).
 */
import { randomUUID } from 'node:crypto'
import { log } from '../log.js'
import type { Store } from '../store/store.js'
import { setRelayState, type ControlState } from '../control/killSwitch.js'

const INSTANCE_ID_KEY = 'rak00n:instance:id'
const INSTANCE_TOKEN_KEY = 'rak00n:relay:instance_token'
const HEARTBEAT_INTERVAL_MS = 30_000
const REPORT_TIMEOUT_MS = 5_000
const REGISTER_BACKOFF_S = [5, 30, 120, 600, 1800] as const

export type RelayConfig = {
  relayUrl: string
  eventSecret: string
  instanceId?: string
}

export type InstanceInfo = {
  instanceId: string
  agentId: string
  version: string
  startedAt: string
  models: string[]
  workerMode: string
  environment: string
  secretSource: string
  features: Record<string, boolean>
}

// Queued events for batch sending
type TokenUsageEvent = {
  user_email?: string
  user_oid?: string
  tenant_id?: string
  session_id?: string
  provider?: string
  model?: string
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  duration_ms?: number
  streaming?: boolean
  at: string
}

type SessionEvent = {
  type: 'session.created' | 'session.completed' | 'session.archived'
  session_id: string
  instance_id: string
  model?: string
  prompt_tokens?: number
  completion_tokens?: number
  tool_count?: number
  duration_ms?: number
  at: string
}

type AuditEnvelope = {
  ts: string
  oid?: string
  keyId?: string
  event: string
  route?: string
  status?: number
  latencyMs?: number
  data?: Record<string, unknown>
  // Filled in at flush time
  instance_id?: string
  tenant_id?: string
}

export type MemoryDigest = {
  note_count: number
  total_bytes: number
  last_extraction_at?: string
  last_consolidation_at?: string
  tags?: string[]
}

export type DashboardSnapshot = {
  instance_id: string
  at: string
  health: {
    redis_ok?: boolean
    vault_ok?: boolean | null
    active_streams: number
    worker_mode: string
    workers?: { active: number; total: number } | null
    default_model?: string | null
  }
  sessions: {
    total: number
  }
  users: {
    all_time: number
    active_24h: number
    active_7d: number
    weekly_avg_per_day: number
  }
  tokens: {
    prompt: number
    completion: number
    total: number
    usd: number
    by_model: Array<{ model: string; prompt: number; completion: number; turns: number }>
  }
  chat_outcomes: Record<string, number>
  top_tools: Array<{ tool: string; invocations: number }>
  tool_latency_ms: Record<string, {
    count: number
    avg_ms: number
    p50_ms: number
    p95_ms: number
    p99_ms: number
    max_ms: number
  }>
  turn_latency_ms: Record<string, {
    count: number
    avg_ms: number
    p50_ms: number
    p95_ms: number
    p99_ms: number
    max_ms: number
  }>
  discovered_repos: Array<{ source_repo?: string; kind?: string; ok?: boolean; counts?: { skills?: number; agents?: number; mcps?: number } }>
}

let _reporter: RelayReporter | null = null

export type RelayStatus =
  | 'unconfigured'
  | 'registering'
  | 'connected'
  | 'degraded'
  | 'disconnected'

export class RelayReporter {
  private relayUrl: string
  private eventSecret: string
  private instanceId: string
  private instanceToken: string | null = null
  private info: InstanceInfo | null = null
  private store: Store | null = null
  private heartbeatHandle: ReturnType<typeof setInterval> | null = null
  private pendingUsage: TokenUsageEvent[] = []
  private pendingSessions: SessionEvent[] = []
  private pendingAudit: AuditEnvelope[] = []
  private flushHandle: ReturnType<typeof setInterval> | null = null
  workerStats: { active: number; total: number } = { active: 0, total: 0 }
  private memoryDigest: MemoryDigest | null = null
  private memorySyncEnabled: boolean = false
  private status: RelayStatus = 'unconfigured'
  private lastError: string | null = null
  private lastBeatAt: string | null = null
  private registeredAt: string | null = null
  private registerAttempt = 0
  private registerHandle: ReturnType<typeof setTimeout> | null = null

  constructor(private config: RelayConfig) {
    this.memorySyncEnabled = process.env.RAK00N_RELAY_MEMORY_SYNC === 'true'
    this.relayUrl = config.relayUrl.replace(/\/+$/, '')
    this.eventSecret = config.eventSecret
    this.instanceId = config.instanceId || ''
  }

  async start(store: Store, info: InstanceInfo): Promise<void> {
    this.store = store
    // Resolve or generate instance ID
    if (!this.instanceId) {
      const stored = await store.getKv(INSTANCE_ID_KEY)
      if (stored) {
        this.instanceId = stored
      } else {
        this.instanceId = `rak00n-${randomUUID().slice(0, 8)}`
        await store.putKv(INSTANCE_ID_KEY, this.instanceId, 0)
      }
    }
    info.instanceId = this.instanceId
    this.info = info

    // Phase 2: try to recover an existing instance token from Redis
    // (so a router restart doesn't force a full re-register).
    try {
      const cached = await store.getKv(INSTANCE_TOKEN_KEY)
      if (cached) {
        this.instanceToken = cached
        this.registeredAt = (await store.getKv(`${INSTANCE_TOKEN_KEY}:at`)) ?? null
      }
    } catch {
      // ignore — we'll just register fresh
    }

    log.info('relay_reporter_started', {
      relayUrl: this.relayUrl,
      instanceId: this.instanceId,
      hasCachedToken: !!this.instanceToken,
    })

    this.status = 'registering'
    // Kick off registration in the background (never blocks boot).
    this.scheduleRegister(0)

    // Initial heartbeat — works whether or not the registration has
    // completed, because heartbeat ingest accepts shared-secret too.
    void this.sendHeartbeat()

    // Periodic heartbeat
    this.heartbeatHandle = setInterval(() => {
      this.sendHeartbeat().catch(() => {})
    }, HEARTBEAT_INTERVAL_MS)

    // Flush pending events every 10s
    this.flushHandle = setInterval(() => {
      this.flush().catch(() => {})
    }, 10_000)
  }

  stop(): void {
    if (this.heartbeatHandle) clearInterval(this.heartbeatHandle)
    if (this.flushHandle) clearInterval(this.flushHandle)
    if (this.registerHandle) clearTimeout(this.registerHandle)
    this.flush().catch(() => {})
  }

  // ─── Phase 2: registration handshake ───

  getStatus(): {
    enabled: boolean
    status: RelayStatus
    instance_id: string
    relay_url: string
    last_beat_at: string | null
    registered_at: string | null
    error: string | null
  } {
    return {
      enabled: !!this.relayUrl,
      status: this.status,
      instance_id: this.instanceId,
      relay_url: this.relayUrl,
      last_beat_at: this.lastBeatAt,
      registered_at: this.registeredAt,
      error: this.lastError,
    }
  }

  async forceRegister(): Promise<boolean> {
    if (this.registerHandle) clearTimeout(this.registerHandle)
    this.registerAttempt = 0
    return this.register()
  }

  private scheduleRegister(delaySeconds: number): void {
    if (this.registerHandle) clearTimeout(this.registerHandle)
    this.registerHandle = setTimeout(() => {
      this.register().catch(() => {})
    }, Math.max(0, delaySeconds) * 1000)
  }

  private async register(): Promise<boolean> {
    if (!this.relayUrl) {
      this.status = 'unconfigured'
      return false
    }
    this.status = this.instanceToken ? 'connected' : 'registering'
    try {
      const res = await fetch(`${this.relayUrl}/v1/instances/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Relay-Event-Secret': this.eventSecret,
        },
        body: JSON.stringify({
          instance_id: this.instanceId,
          agent_id: this.info?.agentId,
          version: this.info?.version,
          environment: this.info?.environment,
          tenant_id: process.env.RAK00N_TENANT_ID,
        }),
        signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
      })
      if (!res.ok) {
        throw new Error(`register HTTP ${res.status}`)
      }
      const data = (await res.json()) as { instance_token?: string; registered_at?: string }
      if (!data.instance_token) throw new Error('register: no instance_token in response')
      this.instanceToken = data.instance_token
      this.registeredAt = data.registered_at ?? new Date().toISOString()
      this.lastError = null
      this.status = 'connected'
      this.registerAttempt = 0
      // Persist so a restart doesn't force a re-register.
      try {
        if (this.store) {
          await this.store.putKv(INSTANCE_TOKEN_KEY, this.instanceToken, 86400)
          await this.store.putKv(`${INSTANCE_TOKEN_KEY}:at`, this.registeredAt, 86400)
        }
      } catch {
        // ignore
      }
      log.info('relay_registered', {
        instanceId: this.instanceId,
        registeredAt: this.registeredAt,
      })
      return true
    } catch (err) {
      this.lastError = (err as Error).message
      this.status = this.instanceToken ? 'degraded' : 'disconnected'
      const idx = Math.min(this.registerAttempt, REGISTER_BACKOFF_S.length - 1)
      const delay = REGISTER_BACKOFF_S[idx]
      this.registerAttempt += 1
      log.warn('relay_register_failed', {
        instanceId: this.instanceId,
        error: this.lastError,
        retryInSeconds: delay,
        attempt: this.registerAttempt,
      })
      this.scheduleRegister(delay)
      return false
    }
  }

  private buildHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Relay-Event-Secret': this.eventSecret,
      'X-Rak00n-Instance-Id': this.instanceId,
    }
    if (this.instanceToken) {
      h['Authorization'] = `Bearer ${this.instanceToken}`
    }
    return h
  }

  // ─── Public API for recording events ───

  recordTokenUsage(event: Omit<TokenUsageEvent, 'at'>): void {
    this.pendingUsage.push({ ...event, at: new Date().toISOString() })
  }

  recordSessionEvent(event: Omit<SessionEvent, 'at' | 'instance_id'>): void {
    this.pendingSessions.push({
      ...event,
      instance_id: this.instanceId,
      at: new Date().toISOString(),
    })
  }

  recordAuditEvent(event: AuditEnvelope): void {
    if (!this.relayUrl) return
    if (this.pendingAudit.length >= 5000) {
      // Drop oldest to keep memory bounded; the local audit log
      // remains the source of truth.
      this.pendingAudit.splice(0, this.pendingAudit.length - 4000)
    }
    this.pendingAudit.push({
      ...event,
      instance_id: this.instanceId,
      tenant_id: process.env.RAK00N_TENANT_ID,
    })
  }

  recordMemoryDigest(digest: MemoryDigest): void {
    this.memoryDigest = digest
    if (this.memorySyncEnabled && this.relayUrl) {
      this.fireAndForget(`${this.relayUrl}/v1/events/memory-digest`, {
        instance_id: this.instanceId,
        ...digest,
        at: new Date().toISOString(),
      })
    }
  }

  /** Fire-and-forget a full dashboard telemetry snapshot. The relay
   *  may expose this on its operator dashboard so HQ sees the same
   *  view per-instance the local console renders. */
  recordDashboardSnapshot(snapshot: DashboardSnapshot): void {
    if (!this.relayUrl) return
    this.fireAndForget(`${this.relayUrl}/v1/events/dashboard`, snapshot)
  }

  getInstanceId(): string {
    return this.instanceId
  }

  isMemorySyncEnabled(): boolean {
    return this.memorySyncEnabled
  }

  // ─── Internal ───

  private async sendHeartbeat(): Promise<void> {
    if (!this.info) return
    try {
      const res = await fetch(`${this.relayUrl}/v1/events/heartbeat`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          instance_id: this.instanceId,
          agent_id: this.info.agentId,
          version: this.info.version,
          started_at: this.info.startedAt,
          models: this.info.models,
          worker_mode: this.info.workerMode,
          environment: this.info.environment,
          secret_source: this.info.secretSource,
          features: this.info.features,
          workers: this.workerStats,
          memory: this.memoryDigest,
          status: 'healthy',
          at: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
      })
      this.lastBeatAt = new Date().toISOString()
      if (res.ok) {
        if (this.instanceToken) {
          this.status = 'connected'
          this.lastError = null
        }
        // Phase 4: heartbeat ACK carries control state. The relay
        // returns 200 + { control: { state, reason, actor } } when an
        // operator has flipped state via the dashboard, and 204 (no
        // body) when the desired state is 'active'. So a successful
        // 204 response is the canonical 'no kill in effect' signal
        // and we MUST reset the local relay snapshot accordingly.
        if (res.status === 204) {
          await setRelayState('active')
        } else {
          try {
            const data = (await res.json()) as {
              control?: { state?: string; reason?: string; actor?: string }
            }
            if (data?.control && typeof data.control.state === 'string') {
              const s = data.control.state as ControlState
              if (s === 'active' || s === 'draining' || s === 'disabled') {
                await setRelayState(s, data.control.reason, data.control.actor)
              }
            } else {
              await setRelayState('active')
            }
          } catch {
            // Ack with non-JSON body — assume no kill.
            await setRelayState('active')
          }
        }
      } else if (res.status === 401 && this.instanceToken) {
        // Token rejected — likely the relay forgot us (Redis flush).
        // Drop the token and fall back to the bootstrap secret while
        // a re-register attempt runs in the background.
        log.warn('relay_token_rejected', { status: res.status })
        this.instanceToken = null
        this.status = 'degraded'
        if (this.store) await this.store.putKv(INSTANCE_TOKEN_KEY, '', 1).catch(() => {})
        this.scheduleRegister(0)
      }
    } catch (err) {
      this.lastError = (err as Error).message
      this.status = this.instanceToken ? 'degraded' : 'disconnected'
      log.warn('relay_heartbeat_failed', { error: this.lastError })
    }
  }

  private async flush(): Promise<void> {
    // Flush token usage
    if (this.pendingUsage.length > 0) {
      const batch = this.pendingUsage.splice(0, 50)
      for (const event of batch) {
        this.fireAndForget(`${this.relayUrl}/v1/events/token-usage`, event)
      }
    }

    // Flush session events
    if (this.pendingSessions.length > 0) {
      const batch = this.pendingSessions.splice(0, 50)
      for (const event of batch) {
        this.fireAndForget(`${this.relayUrl}/v1/events/session`, event)
      }
    }

    // Flush audit events (batched up to 100 per call)
    if (this.pendingAudit.length > 0) {
      while (this.pendingAudit.length > 0) {
        const batch = this.pendingAudit.splice(0, 100)
        this.fireAndForget(`${this.relayUrl}/v1/events/audit-batch`, {
          instance_id: this.instanceId,
          events: batch,
        })
      }
    }
  }

  private fireAndForget(url: string, body: unknown): void {
    fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    }).catch(() => {
      // Silently drop — relay is fire-and-forget
    })
  }
}

// ─── Singleton access ───

export function initRelayReporter(config: RelayConfig): RelayReporter {
  _reporter = new RelayReporter(config)
  return _reporter
}

export function getRelayReporter(): RelayReporter | null {
  return _reporter
}
