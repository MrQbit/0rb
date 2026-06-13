/**
 * Stateless-pod storage abstraction.
 *
 * Two implementations:
 *   - RedisStore: production. Uses Bun's built-in `Bun.RedisClient`
 *     when available, falling back to a thin RESP client when running
 *     in Node. Keys are namespaced with `RAK00N_REDIS_PREFIX` (default
 *     "rak00n:") so multiple deployments can share one instance.
 *   - MemoryStore: dev-only. Single-process Map; data evaporates on
 *     pod restart. Picked when `REDIS_URL` is unset.
 *
 * Pod-local in-memory state is forbidden in the API layer (sticky
 * routing is not required) — every read/write the request handler
 * makes goes through this Store.
 */
export interface Store {
  // Sessions: append-only message log per session id.
  getSession(id: string): Promise<unknown[] | null>
  setSession(id: string, messages: unknown[], ttlSeconds: number): Promise<void>
  delSession(id: string): Promise<void>
  listSessionsForOwner(ownerOid: string): Promise<string[]>
  setSessionMeta(
    id: string,
    meta: Record<string, string>,
    ttlSeconds: number,
  ): Promise<void>
  getSessionMeta(id: string): Promise<Record<string, string> | null>

  // API keys: hash → metadata.
  getApiKey(hash: string): Promise<ApiKeyRecord | null>
  putApiKey(hash: string, record: ApiKeyRecord): Promise<void>
  delApiKey(hash: string): Promise<void>
  listApiKeysForOwner(ownerOid: string): Promise<ApiKeyRecord[]>
  /**
   * Iterate every key in the store. Admin-only operations (list-all,
   * revoke-by-id) use this; for typical multi-key counts (~hundreds)
   * the linear scan is fine.
   */
  listAllApiKeys(): Promise<{ hash: string; record: ApiKeyRecord }[]>
  /**
   * Look up the full sha256 hash for a given owner + public id pair.
   * Public id is by convention the first 8 hex chars of the hash;
   * scanning the per-owner set is O(n_keys) which is acceptable.
   */
  findKeyHashByPublicId(ownerOid: string, publicId: string): Promise<string | null>

  // Audit log: append + tail.
  pushAudit(date: string, event: AuditEvent): Promise<void>
  tailAudit(date: string, limit: number): Promise<AuditEvent[]>

  // OIDC nonces / cookie sessions: short-lived shared state.
  putKv(key: string, value: string, ttlSeconds: number): Promise<void>
  getKv(key: string): Promise<string | null>
  delKv(key: string): Promise<void>
  // Atomic read-and-delete. Used by worker dispatch to guarantee
  // exactly-once consumption of a per-turn task payload even if two
  // worker pods race for the same turnId.
  getDelKv(key: string): Promise<string | null>
  // Atomic claim: SETs the key only if absent and returns true.
  // Used to guarantee a turn is dispatched at most once.
  claim(key: string, ttlSeconds: number): Promise<boolean>

  // Append-only event lists (used by worker dispatch for streaming events).
  // `pushList` RPUSHes; `popListAll` reads everything pending and clears it.
  pushList(key: string, value: string, ttlSeconds: number): Promise<void>
  popListAll(key: string, max: number): Promise<string[]>

  /**
   * Sliding-window rate limiter. Atomically prunes entries older than
   * `nowMs - windowMs`, counts what's left, and if under `capacity`
   * inserts a new entry and returns { allowed: true, remaining }.
   * Otherwise returns { allowed: false, remaining: 0, retryAfterMs }.
   * Backed by Redis ZSET + EVAL Lua in prod, by an in-memory map in dev.
   */
  rateLimitCheck(
    key: string,
    windowMs: number,
    capacity: number,
    nowMs: number,
  ): Promise<{ allowed: boolean; remaining: number; retryAfterMs: number }>

  ping(): Promise<boolean>
}

export type ApiKeyRecord = {
  id: string // public id for revoke (last 8 hex of hash)
  ownerOid: string
  ownerEmail: string
  name: string
  createdAt: string
  lastUsedAt?: string
  allowedModels?: string[] // empty / undefined = all
  allowedTools?: string[] // empty / undefined = all
  scopes?: string[]
  /** Admin keys can mint/revoke other keys and read /v1/audit. */
  admin?: boolean
}

export type AuditEvent = {
  ts: string
  oid?: string
  keyId?: string
  event: string // 'auth.login' | 'key.created' | 'chat.started' | ...
  route?: string
  status?: number
  latencyMs?: number
  data?: Record<string, unknown>
}

const PREFIX = process.env.RAK00N_REDIS_PREFIX ?? 'rak00n:'

class MemoryStore implements Store {
  private kv = new Map<string, { v: string; expiresAt?: number }>()
  private lists = new Map<string, string[]>()
  private sets = new Map<string, Set<string>>()

  private now() {
    return Date.now()
  }
  private notExpired(e?: { expiresAt?: number }) {
    return !e?.expiresAt || e.expiresAt > this.now()
  }

  async getSession(id: string): Promise<unknown[] | null> {
    const e = this.kv.get(`${PREFIX}session:${id}`)
    if (!e || !this.notExpired(e)) return null
    return JSON.parse(e.v)
  }
  async setSession(id: string, messages: unknown[], ttl: number) {
    this.kv.set(`${PREFIX}session:${id}`, {
      v: JSON.stringify(messages),
      expiresAt: ttl > 0 ? this.now() + ttl * 1000 : undefined,
    })
  }
  async delSession(id: string) {
    this.kv.delete(`${PREFIX}session:${id}`)
    this.kv.delete(`${PREFIX}session:${id}:meta`)
  }
  async listSessionsForOwner(oid: string): Promise<string[]> {
    return Array.from(this.sets.get(`${PREFIX}owner:${oid}:sessions`) ?? [])
  }
  async setSessionMeta(id: string, meta: Record<string, string>, ttl: number) {
    this.kv.set(`${PREFIX}session:${id}:meta`, {
      v: JSON.stringify(meta),
      expiresAt: ttl > 0 ? this.now() + ttl * 1000 : undefined,
    })
    if (meta.ownerOid) {
      const set = this.sets.get(`${PREFIX}owner:${meta.ownerOid}:sessions`) ??
        new Set<string>()
      set.add(id)
      this.sets.set(`${PREFIX}owner:${meta.ownerOid}:sessions`, set)
    }
  }
  async getSessionMeta(id: string) {
    const e = this.kv.get(`${PREFIX}session:${id}:meta`)
    if (!e || !this.notExpired(e)) return null
    return JSON.parse(e.v)
  }

  async getApiKey(hash: string) {
    const e = this.kv.get(`${PREFIX}apikey:${hash}`)
    if (!e || !this.notExpired(e)) return null
    return JSON.parse(e.v)
  }
  async putApiKey(hash: string, record: ApiKeyRecord) {
    this.kv.set(`${PREFIX}apikey:${hash}`, { v: JSON.stringify(record) })
    const set = this.sets.get(`${PREFIX}owner:${record.ownerOid}:keys`) ??
      new Set<string>()
    set.add(hash)
    this.sets.set(`${PREFIX}owner:${record.ownerOid}:keys`, set)
  }
  async delApiKey(hash: string) {
    const r = await this.getApiKey(hash)
    this.kv.delete(`${PREFIX}apikey:${hash}`)
    if (r) {
      const set = this.sets.get(`${PREFIX}owner:${r.ownerOid}:keys`)
      if (set) set.delete(hash)
    }
  }
  async listApiKeysForOwner(oid: string): Promise<ApiKeyRecord[]> {
    const hashes = Array.from(this.sets.get(`${PREFIX}owner:${oid}:keys`) ?? [])
    const out: ApiKeyRecord[] = []
    for (const h of hashes) {
      const r = await this.getApiKey(h)
      if (r) out.push(r)
    }
    return out
  }
  async findKeyHashByPublicId(oid: string, publicId: string) {
    const set = this.sets.get(`${PREFIX}owner:${oid}:keys`)
    if (!set) return null
    for (const h of set) if (h.startsWith(publicId)) return h
    return null
  }
  async listAllApiKeys(): Promise<{ hash: string; record: ApiKeyRecord }[]> {
    const out: { hash: string; record: ApiKeyRecord }[] = []
    const prefix = `${PREFIX}apikey:`
    for (const [k, e] of this.kv) {
      if (!k.startsWith(prefix)) continue
      if (!this.notExpired(e)) continue
      const hash = k.slice(prefix.length)
      try {
        out.push({ hash, record: JSON.parse(e.v) })
      } catch {
        /* corrupt; skip */
      }
    }
    return out
  }

  async pushAudit(date: string, event: AuditEvent) {
    const key = `${PREFIX}audit:${date}`
    const list = this.lists.get(key) ?? []
    list.push(JSON.stringify(event))
    // Trim retention to ~10000 events per day per pod (memory only).
    if (list.length > 10000) list.splice(0, list.length - 10000)
    this.lists.set(key, list)
  }
  async tailAudit(date: string, limit: number): Promise<AuditEvent[]> {
    const key = `${PREFIX}audit:${date}`
    const list = this.lists.get(key) ?? []
    const slice = list.slice(-limit)
    return slice.map(s => JSON.parse(s))
  }

  async putKv(key: string, value: string, ttl: number) {
    this.kv.set(`${PREFIX}kv:${key}`, {
      v: value,
      expiresAt: ttl > 0 ? this.now() + ttl * 1000 : undefined,
    })
  }
  async getKv(key: string): Promise<string | null> {
    const e = this.kv.get(`${PREFIX}kv:${key}`)
    if (!e || !this.notExpired(e)) return null
    return e.v
  }
  async delKv(key: string) {
    this.kv.delete(`${PREFIX}kv:${key}`)
  }
  async getDelKv(key: string): Promise<string | null> {
    const k = `${PREFIX}kv:${key}`
    const e = this.kv.get(k)
    if (!e || !this.notExpired(e)) {
      this.kv.delete(k)
      return null
    }
    this.kv.delete(k)
    return e.v
  }
  async claim(key: string, ttl: number): Promise<boolean> {
    const k = `${PREFIX}kv:${key}`
    const existing = this.kv.get(k)
    if (existing && this.notExpired(existing)) return false
    this.kv.set(k, {
      v: '1',
      expiresAt: ttl > 0 ? this.now() + ttl * 1000 : undefined,
    })
    return true
  }

  async pushList(key: string, value: string, ttl: number) {
    const k = `${PREFIX}list:${key}`
    const list = this.lists.get(k) ?? []
    list.push(value)
    this.lists.set(k, list)
    if (ttl > 0) {
      setTimeout(() => {
        if (this.lists.get(k) === list) this.lists.delete(k)
      }, ttl * 1000).unref?.()
    }
  }
  async popListAll(key: string, max: number): Promise<string[]> {
    const k = `${PREFIX}list:${key}`
    const list = this.lists.get(k) ?? []
    if (list.length === 0) return []
    const out = list.splice(0, max)
    return out
  }

  private rl = new Map<string, number[]>()
  async rateLimitCheck(key: string, windowMs: number, capacity: number, nowMs: number) {
    const arr = this.rl.get(key) ?? []
    const cutoff = nowMs - windowMs
    let i = 0
    while (i < arr.length && arr[i]! <= cutoff) i++
    const pruned = arr.slice(i)
    if (pruned.length >= capacity) {
      const retryAfterMs = Math.max(1, (pruned[0]! + windowMs) - nowMs)
      this.rl.set(key, pruned)
      return { allowed: false, remaining: 0, retryAfterMs }
    }
    pruned.push(nowMs)
    this.rl.set(key, pruned)
    return { allowed: true, remaining: capacity - pruned.length, retryAfterMs: 0 }
  }

  async ping() {
    return true
  }
}

class RedisStore implements Store {
  private client: any
  constructor(client: any) {
    this.client = client
  }

  private k(suffix: string) {
    return `${PREFIX}${suffix}`
  }

  async getSession(id: string): Promise<unknown[] | null> {
    const v = await this.client.get(this.k(`session:${id}`))
    return v ? JSON.parse(v) : null
  }
  async setSession(id: string, messages: unknown[], ttl: number) {
    const k = this.k(`session:${id}`)
    await this.client.set(k, JSON.stringify(messages))
    if (ttl > 0) await this.client.expire(k, ttl)
  }
  async delSession(id: string) {
    await this.client.del(this.k(`session:${id}`))
    await this.client.del(this.k(`session:${id}:meta`))
  }
  async listSessionsForOwner(oid: string): Promise<string[]> {
    const set = await this.client.send('SMEMBERS', [
      this.k(`owner:${oid}:sessions`),
    ])
    return Array.isArray(set) ? set : []
  }
  async setSessionMeta(id: string, meta: Record<string, string>, ttl: number) {
    const k = this.k(`session:${id}:meta`)
    await this.client.set(k, JSON.stringify(meta))
    if (ttl > 0) await this.client.expire(k, ttl)
    if (meta.ownerOid) {
      await this.client.send('SADD', [
        this.k(`owner:${meta.ownerOid}:sessions`),
        id,
      ])
    }
  }
  async getSessionMeta(id: string) {
    const v = await this.client.get(this.k(`session:${id}:meta`))
    return v ? JSON.parse(v) : null
  }

  async getApiKey(hash: string) {
    const v = await this.client.get(this.k(`apikey:${hash}`))
    return v ? JSON.parse(v) : null
  }
  async putApiKey(hash: string, record: ApiKeyRecord) {
    await this.client.set(this.k(`apikey:${hash}`), JSON.stringify(record))
    await this.client.send('SADD', [
      this.k(`owner:${record.ownerOid}:keys`),
      hash,
    ])
  }
  async delApiKey(hash: string) {
    const r = await this.getApiKey(hash)
    await this.client.del(this.k(`apikey:${hash}`))
    if (r) {
      await this.client.send('SREM', [this.k(`owner:${r.ownerOid}:keys`), hash])
    }
  }
  async listApiKeysForOwner(oid: string): Promise<ApiKeyRecord[]> {
    const hashes = await this.client.send('SMEMBERS', [
      this.k(`owner:${oid}:keys`),
    ])
    if (!Array.isArray(hashes) || hashes.length === 0) return []
    const out: ApiKeyRecord[] = []
    for (const h of hashes) {
      const r = await this.getApiKey(h)
      if (r) out.push(r)
    }
    return out
  }
  async findKeyHashByPublicId(oid: string, publicId: string) {
    const hashes = await this.client.send('SMEMBERS', [
      this.k(`owner:${oid}:keys`),
    ])
    if (!Array.isArray(hashes)) return null
    for (const h of hashes) {
      if (typeof h === 'string' && h.startsWith(publicId)) return h
    }
    return null
  }
  async listAllApiKeys(): Promise<{ hash: string; record: ApiKeyRecord }[]> {
    // SCAN instead of KEYS so we don't block Redis on large sets.
    const out: { hash: string; record: ApiKeyRecord }[] = []
    const matchPrefix = this.k('apikey:')
    let cursor = '0'
    do {
      const reply = await this.client.send('SCAN', [
        cursor,
        'MATCH',
        `${matchPrefix}*`,
        'COUNT',
        '500',
      ])
      if (!Array.isArray(reply) || reply.length < 2) break
      cursor = String(reply[0])
      const keys = reply[1]
      if (Array.isArray(keys)) {
        for (const k of keys) {
          if (typeof k !== 'string') continue
          const v = await this.client.get(k)
          if (!v) continue
          try {
            out.push({
              hash: k.slice(matchPrefix.length),
              record: JSON.parse(v),
            })
          } catch {
            /* skip */
          }
        }
      }
    } while (cursor !== '0')
    return out
  }

  async pushAudit(date: string, event: AuditEvent) {
    const k = this.k(`audit:${date}`)
    await this.client.send('RPUSH', [k, JSON.stringify(event)])
    // 30-day retention.
    await this.client.expire(k, 60 * 60 * 24 * 30)
  }
  async tailAudit(date: string, limit: number): Promise<AuditEvent[]> {
    const events = await this.client.send('LRANGE', [
      this.k(`audit:${date}`),
      String(-limit),
      '-1',
    ])
    if (!Array.isArray(events)) return []
    return events.map((s: string) => {
      try {
        return JSON.parse(s)
      } catch {
        return { ts: '', event: 'invalid', data: { raw: s } } as AuditEvent
      }
    })
  }

  async putKv(key: string, value: string, ttl: number) {
    const k = this.k(`kv:${key}`)
    await this.client.set(k, value)
    if (ttl > 0) await this.client.expire(k, ttl)
  }
  async getKv(key: string) {
    return this.client.get(this.k(`kv:${key}`))
  }
  async delKv(key: string) {
    await this.client.del(this.k(`kv:${key}`))
  }
  async getDelKv(key: string): Promise<string | null> {
    const k = this.k(`kv:${key}`)
    // GETDEL is atomic and lands in one round-trip (Redis ≥ 6.2).
    try {
      const v = await this.client.send('GETDEL', [k])
      if (v === null || v === undefined) return null
      return typeof v === 'string' ? v : String(v)
    } catch {
      // Fallback for older Redis: GET then DEL. Race-tolerant for
      // single-publisher/single-consumer workflows we use it for.
      const v = await this.client.get(k)
      if (v === null || v === undefined) return null
      await this.client.del(k)
      return typeof v === 'string' ? v : String(v)
    }
  }
  async claim(key: string, ttl: number): Promise<boolean> {
    const k = this.k(`kv:${key}`)
    const args: string[] = [k, '1', 'NX']
    if (ttl > 0) args.push('EX', String(ttl))
    const reply = await this.client.send('SET', args)
    return reply === 'OK' || reply === 'ok'
  }

  async pushList(key: string, value: string, ttl: number) {
    const k = this.k(`list:${key}`)
    await this.client.send('RPUSH', [k, value])
    if (ttl > 0) await this.client.expire(k, ttl)
  }
  async popListAll(key: string, max: number): Promise<string[]> {
    const k = this.k(`list:${key}`)
    // Atomic drain: read up to `max` then trim. Race-tolerant because
    // each turn has exactly one publisher and one consumer.
    const items = await this.client.send('LRANGE', [k, '0', String(max - 1)])
    if (!Array.isArray(items) || items.length === 0) return []
    await this.client.send('LTRIM', [k, String(items.length), '-1'])
    return items.map((x: any) => String(x))
  }

  async rateLimitCheck(key: string, windowMs: number, capacity: number, nowMs: number) {
    const fullKey = this.k(`rl:${key}`)
    const cutoff = nowMs - windowMs
    // EVAL: prune old entries, count, gate, insert if allowed.
    const lua = `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      local cutoff = tonumber(ARGV[2])
      local cap = tonumber(ARGV[3])
      local windowMs = tonumber(ARGV[4])
      redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
      local n = redis.call('ZCARD', key)
      if n >= cap then
        local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
        local retry = windowMs
        if oldest[2] then retry = math.max(1, (tonumber(oldest[2]) + windowMs) - now) end
        return {0, 0, retry}
      end
      redis.call('ZADD', key, now, tostring(now) .. ':' .. tostring(math.random()))
      redis.call('PEXPIRE', key, windowMs * 2)
      return {1, cap - (n + 1), 0}
    `
    try {
      const r: any = await this.client.send('EVAL', [
        lua, '1', fullKey,
        String(nowMs), String(cutoff), String(capacity), String(windowMs),
      ])
      const allowed = (Array.isArray(r) ? Number(r[0]) : 0) === 1
      const remaining = Array.isArray(r) ? Number(r[1]) : 0
      const retryAfterMs = Array.isArray(r) ? Number(r[2]) : 0
      return { allowed, remaining, retryAfterMs }
    } catch {
      // On Redis failure, fail-open: better to serve a few extra requests
      // than to brick the API. Caller still gets logged metrics.
      return { allowed: true, remaining: capacity, retryAfterMs: 0 }
    }
  }

  async ping() {
    try {
      const r = await this.client.send('PING', [])
      return r === 'PONG' || r === 'pong'
    } catch {
      return false
    }
  }
}

let _store: Store | null = null
export async function getStore(): Promise<Store> {
  if (_store) return _store
  const url = process.env.REDIS_URL
  if (!url) {
    _store = new MemoryStore()
    return _store
  }
  // Bun's built-in Redis client is the only client we ship — no
  // ioredis or redis npm dep so the compiled binary stays small.
  const Bun = (globalThis as any).Bun
  if (!Bun?.RedisClient) {
    throw new Error(
      'REDIS_URL is set but Bun.RedisClient is unavailable. The API entrypoint must run under Bun.',
    )
  }
  const client = new Bun.RedisClient(url)
  await client.connect()
  _store = new RedisStore(client)
  return _store
}

/** Reset the cached store. Test-only. */
export function _resetStoreForTests() {
  _store = null
}
