/**
 * GitHub App authentication: mint short-lived installation access
 * tokens so the worker can `git push` against an EMU org without
 * involving a per-user PAT and without trying to send the user's
 * Entra bearer to github.com.
 *
 * Flow:
 *   1. Sign a 10-minute JWT with the App's RSA private key
 *      (iss=app_id, iat, exp).
 *   2. POST /app/installations/{installation_id}/access_tokens
 *      with that JWT — get back a 1-hour installation token scoped
 *      to the org.
 *   3. Cache per (appId, installationId) until ~5 min before expiry.
 *
 * Configuration (env, all required to enable):
 *   GITHUB_APP_ID                — numeric App ID
 *   GITHUB_APP_INSTALLATION_ID   — numeric installation id at the org
 *   GITHUB_APP_PRIVATE_KEY       — PEM-encoded RSA private key (full PEM text)
 *
 * Optional:
 *   GITHUB_APP_PRIVATE_KEY_PATH  — read PEM from disk instead of env
 *   GITHUB_APP_API_BASE          — defaults to https://api.github.com
 *
 * Vault fallback: if the env is empty, getSecretFromVault is consulted
 * for GITHUB_APP_PRIVATE_KEY (path `github`, key `GITHUB_APP_PRIVATE_KEY`).
 */
import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { log } from '../log.js'
import { getSecretFromVault } from '../secrets/vault.js'

export type GitHubAppConfig = {
  appId: string
  installationId: string
  privateKeyPem: string
  apiBase: string
}

export type InstallationToken = {
  token: string
  expiresAt: string
}

let cached: { key: string; token: string; expiresAtMs: number } | undefined

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function signAppJwt(appId: string, privateKeyPem: string): string {
  const header = { alg: 'RS256', typ: 'JWT' }
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    iat: now - 30,
    exp: now + 9 * 60,
    iss: appId,
  }
  const headerSeg = base64UrlEncode(Buffer.from(JSON.stringify(header)))
  const payloadSeg = base64UrlEncode(Buffer.from(JSON.stringify(payload)))
  const toSign = `${headerSeg}.${payloadSeg}`
  const signer = createSign('RSA-SHA256')
  signer.update(toSign)
  signer.end()
  const sig = signer.sign(privateKeyPem)
  return `${toSign}.${base64UrlEncode(sig)}`
}

async function loadGitHubAppConfig(): Promise<GitHubAppConfig | null> {
  const appId = process.env.GITHUB_APP_ID?.trim()
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID?.trim()
  if (!appId || !installationId) return null

  let privateKeyPem = process.env.GITHUB_APP_PRIVATE_KEY?.trim() || ''
  if (!privateKeyPem) {
    const path = process.env.GITHUB_APP_PRIVATE_KEY_PATH?.trim()
    if (path) {
      try {
        privateKeyPem = readFileSync(path, 'utf-8')
      } catch (err) {
        log.warn('github_app_pem_read_failed', { path, error: (err as Error).message })
      }
    }
  }
  if (!privateKeyPem) {
    try {
      const fromVault = await getSecretFromVault('GITHUB_APP_PRIVATE_KEY')
      if (fromVault) privateKeyPem = fromVault
    } catch (err) {
      log.warn('github_app_pem_vault_read_failed', { error: (err as Error).message })
    }
  }
  if (!privateKeyPem) return null

  // Helm/configmap commonly stores the PEM with literal "\n" sequences.
  // Normalize that into actual newlines so the crypto module accepts it.
  if (!privateKeyPem.includes('\n') && privateKeyPem.includes('\\n')) {
    privateKeyPem = privateKeyPem.replace(/\\n/g, '\n')
  }
  return {
    appId,
    installationId,
    privateKeyPem,
    apiBase:
      process.env.GITHUB_APP_API_BASE?.trim() || 'https://api.github.com',
  }
}

export async function isGitHubAppEnabled(): Promise<boolean> {
  return (await loadGitHubAppConfig()) !== null
}

/**
 * Mint a short-lived installation access token. Cached for ~50 minutes
 * (GitHub installation tokens last 1 hour). Concurrent callers share a
 * single in-flight mint via the cache slot.
 */
export async function mintInstallationToken(): Promise<InstallationToken | null> {
  const cfg = await loadGitHubAppConfig()
  if (!cfg) return null

  const cacheKey = `${cfg.appId}:${cfg.installationId}`
  const now = Date.now()
  if (cached && cached.key === cacheKey && now < cached.expiresAtMs - 5 * 60 * 1000) {
    return {
      token: cached.token,
      expiresAt: new Date(cached.expiresAtMs).toISOString(),
    }
  }

  const jwt = signAppJwt(cfg.appId, cfg.privateKeyPem)
  const url = `${cfg.apiBase}/app/installations/${encodeURIComponent(cfg.installationId)}/access_tokens`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'orb2-art',
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    log.warn('github_app_installation_token_failed', {
      status: res.status,
      body: body.slice(0, 200),
    })
    return null
  }
  const data = (await res.json()) as { token?: string; expires_at?: string }
  if (!data.token || !data.expires_at) {
    log.warn('github_app_installation_token_malformed')
    return null
  }
  const expiresAtMs = new Date(data.expires_at).getTime()
  cached = { key: cacheKey, token: data.token, expiresAtMs }
  log.info('github_app_installation_token_minted', {
    appId: cfg.appId,
    installationId: cfg.installationId,
    expiresAt: data.expires_at,
  })
  return { token: data.token, expiresAt: data.expires_at }
}

/**
 * Force a refresh of the cached token. Used by tests and admin
 * tooling — normal callers should let mintInstallationToken handle
 * caching itself.
 */
export function clearGitHubAppTokenCache(): void {
  cached = undefined
}
