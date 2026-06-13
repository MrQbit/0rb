/**
 * API key generation, hashing, and lookup.
 *
 * The plaintext key is shown to the user exactly once at mint time;
 * Redis stores only `sha256(plaintext)` so a leaked Redis snapshot
 * does not yield usable keys. The first 8 hex chars of the hash are
 * exposed as a stable "id" for revoke / list — never the plaintext
 * key suffix.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { ApiKeyRecord, Store } from '../store/store.js'

export type MintedKey = {
  /** Plaintext key, shown ONCE to the user. Never persisted. */
  plaintext: string
  /** Stable id for revoke + list (first 8 hex of hash). */
  id: string
  /** sha256 hash, stored in Redis. */
  hash: string
}

const KEY_PREFIX = 'orb2_'
const PLAINTEXT_BYTES = 32 // 64 hex chars

export function mintApiKey(): MintedKey {
  const plaintext = `${KEY_PREFIX}${randomBytes(PLAINTEXT_BYTES).toString('hex')}`
  const hash = createHash('sha256').update(plaintext).digest('hex')
  const id = hash.slice(0, 8)
  return { plaintext, hash, id }
}

export function hashApiKey(plaintext: string): {
  hash: string
  id: string
} {
  const hash = createHash('sha256').update(plaintext).digest('hex')
  return { hash, id: hash.slice(0, 8) }
}

export function isApiKeyShape(s: string | undefined | null): boolean {
  return (
    typeof s === 'string' &&
    s.startsWith(KEY_PREFIX) &&
    s.length === KEY_PREFIX.length + PLAINTEXT_BYTES * 2
  )
}

export async function lookupApiKey(
  store: Store,
  plaintext: string,
): Promise<ApiKeyRecord | null> {
  if (!isApiKeyShape(plaintext)) return null
  const { hash } = hashApiKey(plaintext)
  return store.getApiKey(hash)
}

export async function touchApiKey(
  store: Store,
  hash: string,
): Promise<void> {
  const record = await store.getApiKey(hash)
  if (!record) return
  record.lastUsedAt = new Date().toISOString()
  await store.putApiKey(hash, record)
}
