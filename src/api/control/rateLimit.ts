/**
 * Per-identity, per-route-bucket sliding-window rate limiter.
 *
 * Keyed by `<oid>:<bucket>` so a single API key cannot exhaust a
 * shared global counter, but the same key can hit /v1/chat as fast
 * as the bucket allows without affecting other buckets (e.g.
 * /v1/keys, /v1/models/reprobe).
 *
 * The Store backend is responsible for atomicity. In Redis-backed
 * deployments the check is a single EVAL Lua so the count + insert
 * is race-free across replicas; in-memory mode is per-pod, fine
 * for local dev.
 */
import type { Store } from '../store/store.js'
import type { CallerIdentity } from '../auth/context.js'
import { attributionFor } from '../auth/context.js'

export type RateLimitBucket = {
  /** Stable id used in the Redis key suffix. */
  name: string
  /** Window length in milliseconds. */
  windowMs: number
  /** Max number of requests per window per identity. */
  capacity: number
}

const ENV_PREFIX = 'ORB2_RATELIMIT_'

function envInt(name: string, fallback: number): number {
  const raw = process.env[ENV_PREFIX + name]
  if (!raw) return fallback
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const MIN = 60_000

export const RATE_LIMIT_BUCKETS = {
  keysWrite:    { name: 'keys.write',    windowMs: MIN, capacity: envInt('KEYS_WRITE', 10) },
  modelsReprobe:{ name: 'models.reprobe',windowMs: MIN, capacity: envInt('MODELS_REPROBE', 1) },
  chat:         { name: 'chat',          windowMs: MIN, capacity: envInt('CHAT', 60) },
  sandbox:      { name: 'sandbox',       windowMs: MIN, capacity: envInt('SANDBOX', 20) },
  toolInvoke:   { name: 'tool.invoke',   windowMs: MIN, capacity: envInt('TOOL_INVOKE', 60) },
  defaultWrite: { name: 'write.default', windowMs: MIN, capacity: envInt('WRITE_DEFAULT', 120) },
} as const

export function isRateLimitEnabled(): boolean {
  return process.env.ORB2_RATELIMIT_ENABLED === '1'
}

export function bucketForRoute(method: string, pathname: string): RateLimitBucket | null {
  if (method === 'OPTIONS' || method === 'GET' || method === 'HEAD') return null
  if (pathname === '/v1/keys') return RATE_LIMIT_BUCKETS.keysWrite
  if (/^\/v1\/keys\/[^/]+$/.test(pathname) && method === 'DELETE') return RATE_LIMIT_BUCKETS.keysWrite
  if (pathname === '/v1/models/reprobe') return RATE_LIMIT_BUCKETS.modelsReprobe
  if (pathname === '/v1/chat' || pathname === '/v1/chat/stream') return RATE_LIMIT_BUCKETS.chat
  if (pathname === '/v1/sandbox/run') return RATE_LIMIT_BUCKETS.sandbox
  if (/^\/v1\/tools\/[^/]+\/invoke$/.test(pathname)) return RATE_LIMIT_BUCKETS.toolInvoke
  if (pathname.startsWith('/v1/')) return RATE_LIMIT_BUCKETS.defaultWrite
  return null
}

export async function checkRateLimit(
  store: Store,
  identity: CallerIdentity,
  method: string,
  pathname: string,
  nowMs: number = Date.now(),
): Promise<
  | { allowed: true; bucket: RateLimitBucket; remaining: number }
  | { allowed: false; bucket: RateLimitBucket; retryAfterMs: number; remaining: 0 }
  | { allowed: true; bucket: null; remaining: -1 }
> {
  if (!isRateLimitEnabled()) {
    return { allowed: true, bucket: null, remaining: -1 }
  }
  const bucket = bucketForRoute(method, pathname)
  if (!bucket) return { allowed: true, bucket: null, remaining: -1 }
  const oid = attributionFor(identity).oid || 'anon'
  const key = `${oid}:${bucket.name}`
  const result = await store.rateLimitCheck(key, bucket.windowMs, bucket.capacity, nowMs)
  if (result.allowed) {
    return { allowed: true, bucket, remaining: result.remaining }
  }
  return { allowed: false, bucket, remaining: 0, retryAfterMs: result.retryAfterMs }
}

export function rateLimitedResponse(retryAfterMs: number, remaining: number, bucket: RateLimitBucket): Response {
  const retrySec = Math.max(1, Math.ceil(retryAfterMs / 1000))
  return new Response(
    JSON.stringify({
      error: 'Too many requests',
      code: 'RATE_LIMITED',
      bucket: bucket.name,
      retry_after_ms: retryAfterMs,
    }),
    {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': String(retrySec),
        'x-ratelimit-bucket': bucket.name,
        'x-ratelimit-limit': String(bucket.capacity),
        'x-ratelimit-remaining': String(remaining),
        'x-ratelimit-reset-ms': String(retryAfterMs),
      },
    },
  )
}
