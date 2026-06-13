/**
 * HashiCorp Vault KV v2 client for secret management.
 *
 * Auth methods:
 *   - token:      VAULT_TOKEN env var (dev/CI)
 *   - kubernetes:  Pod ServiceAccount JWT → Vault login (production)
 *
 * Secrets are stored at `<mount>/data/<path>` (KV v2 engine).
 * Default mount: "secret", configurable via VAULT_SECRET_MOUNT.
 * Default path prefix: "rak00n/", configurable via VAULT_SECRET_PREFIX.
 */
import { readFileSync } from 'node:fs'

export type VaultConfig = {
  addr: string
  authMethod: 'token' | 'kubernetes'
  token?: string
  role?: string
  mount?: string
  prefix?: string
  /** Vault Enterprise namespace, sent as the X-Vault-Namespace header. */
  namespace?: string
}

type VaultLoginResponse = {
  auth: { client_token: string; lease_duration: number }
}

type VaultKvResponse = {
  data: { data: Record<string, string>; metadata: Record<string, unknown> }
}

const K8S_SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token'
const TOKEN_REFRESH_BUFFER_MS = 60_000

export class VaultClient {
  private addr: string
  private mount: string
  private prefix: string
  private namespace: string
  private authMethod: 'token' | 'kubernetes'
  private role: string
  private clientToken: string
  private tokenExpiresAt: number
  private cache = new Map<string, { data: Record<string, string>; fetchedAt: number }>()
  private cacheTtlMs: number

  constructor(config: VaultConfig) {
    this.addr = config.addr.replace(/\/+$/, '')
    this.mount = config.mount || 'secret'
    this.prefix = config.prefix || 'rak00n'
    this.namespace = config.namespace || ''
    this.authMethod = config.authMethod
    this.role = config.role || 'rak00n'
    this.clientToken = config.token || ''
    this.tokenExpiresAt = config.token ? Infinity : 0
    this.cacheTtlMs = 300_000 // 5 min cache
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...(extra ?? {}) }
    if (this.namespace) h['X-Vault-Namespace'] = this.namespace
    return h
  }

  private async ensureToken(): Promise<string> {
    if (this.clientToken && Date.now() < this.tokenExpiresAt - TOKEN_REFRESH_BUFFER_MS) {
      return this.clientToken
    }

    if (this.authMethod === 'token') {
      const envToken = process.env.VAULT_TOKEN
      if (!envToken) throw new Error('VAULT_TOKEN is required when authMethod=token')
      this.clientToken = envToken
      this.tokenExpiresAt = Infinity
      return this.clientToken
    }

    // Kubernetes auth: read SA token, POST to vault login
    let jwt: string
    try {
      jwt = readFileSync(K8S_SA_TOKEN_PATH, 'utf-8').trim()
    } catch (err) {
      throw new Error(`Cannot read K8s SA token at ${K8S_SA_TOKEN_PATH}: ${(err as Error).message}`)
    }

    const loginRes = await fetch(`${this.addr}/v1/auth/kubernetes/login`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ role: this.role, jwt }),
    })

    if (!loginRes.ok) {
      const body = await loginRes.text().catch(() => '')
      throw new Error(`Vault K8s auth failed (${loginRes.status}): ${body.slice(0, 200)}`)
    }

    const loginData = (await loginRes.json()) as VaultLoginResponse
    this.clientToken = loginData.auth.client_token
    this.tokenExpiresAt = Date.now() + loginData.auth.lease_duration * 1000
    return this.clientToken
  }

  async getSecret(path: string): Promise<Record<string, string> | null> {
    const fullPath = `${this.prefix}/${path}`

    // Check cache
    const cached = this.cache.get(fullPath)
    if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
      return cached.data
    }

    const token = await this.ensureToken()
    const url = `${this.addr}/v1/${this.mount}/data/${fullPath}`
    const res = await fetch(url, {
      headers: this.headers({ 'X-Vault-Token': token }),
    })

    if (res.status === 404) return null
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Vault read ${fullPath} failed (${res.status}): ${body.slice(0, 200)}`)
    }

    const kv = (await res.json()) as VaultKvResponse
    const data = kv.data.data
    this.cache.set(fullPath, { data, fetchedAt: Date.now() })
    return data
  }

  async putSecret(path: string, data: Record<string, string>): Promise<void> {
    const fullPath = `${this.prefix}/${path}`
    const token = await this.ensureToken()
    const url = `${this.addr}/v1/${this.mount}/data/${fullPath}`
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers({
        'Content-Type': 'application/json',
        'X-Vault-Token': token,
      }),
      body: JSON.stringify({ data }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Vault write ${fullPath} failed (${res.status}): ${body.slice(0, 200)}`)
    }

    // Invalidate cache
    this.cache.delete(fullPath)
  }

  async deleteSecret(path: string): Promise<void> {
    const fullPath = `${this.prefix}/${path}`
    const token = await this.ensureToken()
    const url = `${this.addr}/v1/${this.mount}/data/${fullPath}`
    const res = await fetch(url, {
      method: 'DELETE',
      headers: this.headers({ 'X-Vault-Token': token }),
    })

    if (!res.ok && res.status !== 404) {
      const body = await res.text().catch(() => '')
      throw new Error(`Vault delete ${fullPath} failed (${res.status}): ${body.slice(0, 200)}`)
    }
    this.cache.delete(fullPath)
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.addr}/v1/sys/health`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      })
      // 200=initialized+unsealed, 429=standby, 472=perf-standby — all OK
      return res.status === 200 || res.status === 429 || res.status === 472
    } catch {
      return false
    }
  }

  invalidateCache(): void {
    this.cache.clear()
  }
}

// Singleton, lazily created
let _client: VaultClient | null = null

export function getVaultClient(): VaultClient | null {
  if (_client) return _client

  const addr = process.env.VAULT_ADDR
  if (!addr) return null

  const authMethod = (process.env.VAULT_AUTH_METHOD || 'token') as 'token' | 'kubernetes'
  _client = new VaultClient({
    addr,
    authMethod,
    token: process.env.VAULT_TOKEN,
    role: process.env.VAULT_ROLE || 'rak00n',
    mount: process.env.VAULT_SECRET_MOUNT || 'secret',
    prefix: process.env.VAULT_SECRET_PREFIX || 'rak00n',
    namespace: process.env.VAULT_NAMESPACE || undefined,
  })
  return _client
}

// ─── Secret path mapping ───
// Maps SETTINGS_KEYS to vault paths and keys
const VAULT_SECRET_MAP: Record<string, { path: string; key: string }> = {
  ANTHROPIC_FOUNDRY_API_KEY: { path: 'foundry', key: 'ANTHROPIC_FOUNDRY_API_KEY' },
  ANTHROPIC_FOUNDRY_BASE_URL: { path: 'foundry', key: 'ANTHROPIC_FOUNDRY_BASE_URL' },
  MCP_SERVER_TOKEN: { path: 'mcp', key: 'MCP_SERVER_TOKEN' },
  RABBITMQ_URL: { path: 'rabbitmq', key: 'RABBITMQ_URL' },
  GITHUB_APP_PRIVATE_KEY: { path: 'github', key: 'GITHUB_APP_PRIVATE_KEY' },
}

export async function getSecretFromVault(envKey: string): Promise<string | null> {
  const client = getVaultClient()
  if (!client) return null
  const mapping = VAULT_SECRET_MAP[envKey]
  if (!mapping) return null
  const data = await client.getSecret(mapping.path)
  return data?.[mapping.key] ?? null
}

export async function putSecretToVault(envKey: string, value: string): Promise<boolean> {
  const client = getVaultClient()
  if (!client) return false
  const mapping = VAULT_SECRET_MAP[envKey]
  if (!mapping) return false

  // Read-modify-write so we don't clobber sibling keys at the same path
  const existing = (await client.getSecret(mapping.path)) || {}
  existing[mapping.key] = value
  await client.putSecret(mapping.path, existing)
  return true
}

export async function deleteSecretFromVault(envKey: string): Promise<boolean> {
  const client = getVaultClient()
  if (!client) return false
  const mapping = VAULT_SECRET_MAP[envKey]
  if (!mapping) return false

  // Read-modify-write; only delete the specific key
  const existing = (await client.getSecret(mapping.path)) || {}
  delete existing[mapping.key]
  if (Object.keys(existing).length === 0) {
    await client.deleteSecret(mapping.path)
  } else {
    await client.putSecret(mapping.path, existing)
  }
  return true
}
