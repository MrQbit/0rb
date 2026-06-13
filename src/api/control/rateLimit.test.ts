import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  RATE_LIMIT_BUCKETS,
  bucketForRoute,
  checkRateLimit,
  isRateLimitEnabled,
  rateLimitedResponse,
} from './rateLimit.ts'

function memStore() {
  const rl = new Map<string, number[]>()
  return {
    async rateLimitCheck(key: string, windowMs: number, capacity: number, nowMs: number) {
      const arr = rl.get(key) ?? []
      const cutoff = nowMs - windowMs
      let i = 0
      while (i < arr.length && arr[i]! <= cutoff) i++
      const pruned = arr.slice(i)
      if (pruned.length >= capacity) {
        const retryAfterMs = Math.max(1, (pruned[0]! + windowMs) - nowMs)
        rl.set(key, pruned)
        return { allowed: false, remaining: 0, retryAfterMs }
      }
      pruned.push(nowMs)
      rl.set(key, pruned)
      return { allowed: true, remaining: capacity - pruned.length, retryAfterMs: 0 }
    },
  } as any
}

const FAKE_IDENTITY = {
  type: 'apikey',
  keyHash: 'h',
  record: {
    id: 'abc12345',
    ownerOid: 'app:alice',
    ownerEmail: 'alice@x',
    name: 'k',
    createdAt: new Date().toISOString(),
  },
} as any

const ORIG = process.env.ORB2_RATELIMIT_ENABLED

describe('rate limiter', () => {
  beforeEach(() => {
    process.env.ORB2_RATELIMIT_ENABLED = '1'
  })
  afterEach(() => {
    if (ORIG === undefined) delete process.env.ORB2_RATELIMIT_ENABLED
    else process.env.ORB2_RATELIMIT_ENABLED = ORIG
  })

  test('isRateLimitEnabled gated on env', () => {
    expect(isRateLimitEnabled()).toBe(true)
    delete process.env.ORB2_RATELIMIT_ENABLED
    expect(isRateLimitEnabled()).toBe(false)
  })

  test('bucketForRoute maps known routes', () => {
    expect(bucketForRoute('POST', '/v1/keys')?.name).toBe('keys.write')
    expect(bucketForRoute('DELETE', '/v1/keys/abc12345')?.name).toBe('keys.write')
    expect(bucketForRoute('POST', '/v1/models/reprobe')?.name).toBe('models.reprobe')
    expect(bucketForRoute('POST', '/v1/chat')?.name).toBe('chat')
    expect(bucketForRoute('POST', '/v1/sandbox/run')?.name).toBe('sandbox')
    expect(bucketForRoute('POST', '/v1/tools/Bash/invoke')?.name).toBe('tool.invoke')
    expect(bucketForRoute('GET', '/v1/keys')).toBeNull()
    expect(bucketForRoute('GET', '/v1/anything')).toBeNull()
    expect(bucketForRoute('POST', '/healthz')).toBeNull()
  })

  test('allows up to capacity, denies past it, then resets after window', async () => {
    const store = memStore()
    const cap = RATE_LIMIT_BUCKETS.keysWrite.capacity
    const win = RATE_LIMIT_BUCKETS.keysWrite.windowMs

    for (let i = 0; i < cap; i++) {
      const r = await checkRateLimit(store, FAKE_IDENTITY, 'POST', '/v1/keys', 1000)
      expect(r.allowed).toBe(true)
    }
    const blocked = await checkRateLimit(store, FAKE_IDENTITY, 'POST', '/v1/keys', 1000)
    expect(blocked.allowed).toBe(false)

    const later = await checkRateLimit(store, FAKE_IDENTITY, 'POST', '/v1/keys', 1000 + win + 1)
    expect(later.allowed).toBe(true)
  })

  test('rateLimitedResponse emits headers + 429', () => {
    const res = rateLimitedResponse(5000, 0, RATE_LIMIT_BUCKETS.keysWrite)
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('5')
    expect(res.headers.get('x-ratelimit-bucket')).toBe('keys.write')
    expect(res.headers.get('x-ratelimit-remaining')).toBe('0')
  })

  test('bypasses when env disabled', async () => {
    delete process.env.ORB2_RATELIMIT_ENABLED
    const store = memStore()
    for (let i = 0; i < 999; i++) {
      const r = await checkRateLimit(store, FAKE_IDENTITY, 'POST', '/v1/keys', 1000)
      expect(r.allowed).toBe(true)
    }
  })
})
