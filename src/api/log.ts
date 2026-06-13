/**
 * Structured logger + audit emitter.
 *
 * - log.info/.warn/.error → JSON to stdout (one line per event), level
 *   gated by RAK00N_API_LOG_LEVEL (default "info").
 * - audit.emit → writes the event to the Store's audit list AND to
 *   stdout (level "audit") so log aggregators capture it even when
 *   Redis is unreachable.
 *
 * No external logger dep — Bun's stdout.write is fast enough for our
 * scale and keeps the compiled binary lean.
 */
import type { Store, AuditEvent } from './store/store.js'

const LEVELS = ['debug', 'info', 'warn', 'error', 'audit'] as const
type Level = (typeof LEVELS)[number]
const minLevel: Level =
  (process.env.RAK00N_API_LOG_LEVEL as Level) || 'info'
const minIndex = LEVELS.indexOf(minLevel)

function emit(level: Level, msg: string, data?: Record<string, unknown>) {
  if (LEVELS.indexOf(level) < minIndex) return
  const line =
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...(data ?? {}),
    }) + '\n'
  // Write directly to stdout to avoid console.log's formatting overhead.
  process.stdout.write(line)
}

export const log = {
  debug(msg: string, data?: Record<string, unknown>) {
    emit('debug', msg, data)
  },
  info(msg: string, data?: Record<string, unknown>) {
    emit('info', msg, data)
  },
  warn(msg: string, data?: Record<string, unknown>) {
    emit('warn', msg, data)
  },
  error(msg: string, data?: Record<string, unknown>) {
    emit('error', msg, data)
  },
}

/**
 * Headers that must never appear in logs or audit records. Anything
 * matching one of these names is replaced with the literal string
 * "[REDACTED]" by `redactHeaders()`.
 */
export const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-foundry-token',
  'x-anthropic-api-key',
  'openai-api-key',
])

/**
 * Return a plain object with all sensitive header values replaced by
 * "[REDACTED]". Accepts a Headers object or any plain record/iterable
 * of [name, value] pairs.
 */
export function redactHeaders(
  headers: Headers | Record<string, string> | Iterable<[string, string]>,
): Record<string, string> {
  const out: Record<string, string> = {}
  const entries: Iterable<[string, string]> =
    headers instanceof Headers
      ? (headers as any).entries()
      : Array.isArray(headers)
      ? (headers as any)
      : typeof (headers as any)[Symbol.iterator] === 'function'
      ? (headers as any)
      : Object.entries(headers as Record<string, string>)
  for (const [rawName, value] of entries) {
    const name = String(rawName).toLowerCase()
    out[name] = SENSITIVE_HEADERS.has(name) ? '[REDACTED]' : String(value)
  }
  return out
}

export type AuditEmitter = (event: Omit<AuditEvent, 'ts'>) => void

/**
 * Build an audit emitter bound to a particular store. The emitter is
 * fire-and-forget — Redis errors do NOT block the request because
 * losing one audit line is acceptable, but losing the user's reply is
 * not. We log Redis failures at warn level for SRE follow-up.
 *
 * Phase 3: every audit event is also pushed to the relay reporter's
 * in-memory buffer when configured. The reporter drains the buffer
 * to /v1/events/audit-batch every 5s; failures are silently dropped
 * because the local audit log remains the source of truth.
 */
export function createAuditEmitter(store: Store): AuditEmitter {
  return event => {
    const full: AuditEvent = { ts: new Date().toISOString(), ...event }
    emit('audit', `audit.${event.event}`, full as Record<string, unknown>)
    const date = full.ts.slice(0, 10)
    store.pushAudit(date, full).catch(err => {
      log.warn('audit_redis_push_failed', {
        error: (err as Error).message,
        event: event.event,
      })
    })
    // Forward to relay (lazy-imported to avoid a cycle: server -> log
    // -> relay -> server).
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./relay/reporter.js') as typeof import('./relay/reporter.js')
      mod.getRelayReporter()?.recordAuditEvent(full)
    } catch {
      // Reporter unavailable — drop silently.
    }
  }
}
