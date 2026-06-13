/**
 * Foundry token minter for the unattended (server) RAK00N API.
 *
 * The CLI's `src/standalone/entraAuth.ts` uses az CLI → device-code
 * flow because it has a human at the keyboard. The API doesn't, so we
 * use the OAuth 2.0 **client_credentials grant** instead — same Entra
 * `/oauth2/v2.0/token` endpoint, same scope
 * (`https://cognitiveservices.azure.com/.default`), but with the SP's
 * tenant + clientId + clientSecret instead of a public-client + device
 * code.
 *
 * The resulting access_token is what every Foundry call uses as its
 * `Authorization: Bearer ...` header — i.e. it's what the rest of the
 * codebase expects to find in `OPENAI_API_KEY`. We mirror the CLI's
 * `tokenRefresher.ts` model: keep the latest token in memory, refresh
 * whenever it has <2 min of life left, and rewrite the env var so any
 * code path that re-reads `process.env.OPENAI_API_KEY` picks up the
 * fresh value.
 *
 * Falls back to az CLI (`az account get-access-token`) when no SP
 * credentials are configured — useful for local dev where the operator
 * is logged in via `az login`.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const FOUNDRY_OAUTH_SCOPE =
  'https://cognitiveservices.azure.com/.default'

const TOKEN_ENDPOINT_TMPL =
  'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token'
const REFRESH_LEAD_MS = 120_000 // refresh if <2min to expiry
const MAX_REFRESH_INTERVAL_MS = 30 * 60 * 1000 // 30 min cap

export type FoundryCredentials = {
  tenantId: string
  clientId: string
  /** Client secret — preferred for unattended servers. */
  clientSecret?: string
  /** Workload-identity assertion (JWT) — alternative to clientSecret. */
  clientAssertion?: string
}

export type FoundryTokenResult = {
  accessToken: string
  expiresAt: number
  oid?: string
  upn?: string
  source: 'client_secret' | 'client_assertion' | 'az-cli' | 'cache'
}

let inMemory: FoundryTokenResult | null = null
let timer: NodeJS.Timeout | null = null
let listeners: ((t: FoundryTokenResult) => void)[] = []

export function getCachedFoundryToken(): FoundryTokenResult | null {
  if (!inMemory) return null
  if (inMemory.expiresAt - Date.now() < 60_000) return null
  return inMemory
}

export function onFoundryTokenRefreshed(
  listener: (t: FoundryTokenResult) => void,
): () => void {
  listeners.push(listener)
  return () => {
    listeners = listeners.filter(l => l !== listener)
  }
}

export async function acquireFoundryToken(
  creds: FoundryCredentials,
): Promise<FoundryTokenResult> {
  if (inMemory && inMemory.expiresAt - Date.now() > REFRESH_LEAD_MS) {
    return { ...inMemory, source: 'cache' }
  }

  if (creds.clientSecret) {
    const result = await mintViaClientCredentials(
      creds.tenantId,
      creds.clientId,
      { secret: creds.clientSecret },
    )
    inMemory = { ...result, source: 'client_secret' }
    notify()
    return inMemory
  }
  if (creds.clientAssertion) {
    const result = await mintViaClientCredentials(
      creds.tenantId,
      creds.clientId,
      { assertion: creds.clientAssertion },
    )
    inMemory = { ...result, source: 'client_assertion' }
    notify()
    return inMemory
  }

  // Last resort — useful for local dev with `az login`.
  const result = await mintViaAzCli(creds.tenantId)
  inMemory = result
  notify()
  return inMemory
}

function notify() {
  if (!inMemory) return
  for (const l of listeners) {
    try {
      l(inMemory)
    } catch {
      /* listeners must not break refresh */
    }
  }
}

async function mintViaClientCredentials(
  tenantId: string,
  clientId: string,
  auth: { secret?: string; assertion?: string },
): Promise<Omit<FoundryTokenResult, 'source'>> {
  const tokenUrl = TOKEN_ENDPOINT_TMPL.replace('{tenant}', tenantId)
  const params = new URLSearchParams({
    client_id: clientId,
    scope: FOUNDRY_OAUTH_SCOPE,
    grant_type: 'client_credentials',
  })
  if (auth.secret) {
    params.set('client_secret', auth.secret)
  } else {
    params.set(
      'client_assertion_type',
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    )
    params.set('client_assertion', auth.assertion!)
  }
  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
  if (!resp.ok) {
    throw new Error(
      `Foundry token request failed (${resp.status}): ${await resp.text()}`,
    )
  }
  const body = (await resp.json()) as {
    access_token: string
    expires_in: number
  }
  const claims = decodeJwtClaims(body.access_token)
  return {
    accessToken: body.access_token,
    expiresAt: Date.now() + (body.expires_in - 60) * 1000,
    oid: claims?.oid,
    upn: claims?.upn ?? claims?.preferred_username,
  }
}

async function mintViaAzCli(tenantId: string): Promise<FoundryTokenResult> {
  const args = [
    'account',
    'get-access-token',
    '--resource',
    'https://cognitiveservices.azure.com',
    '--tenant',
    tenantId,
    '--output',
    'json',
  ]
  const { stdout } = await execFileAsync('az', args, {
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  })
  const parsed = JSON.parse(stdout) as {
    accessToken: string
    expiresOn: string
    expires_on?: number
  }
  const expiresAt = parsed.expires_on
    ? parsed.expires_on * 1000
    : Date.parse(parsed.expiresOn)
  const claims = decodeJwtClaims(parsed.accessToken)
  return {
    accessToken: parsed.accessToken,
    expiresAt,
    oid: claims?.oid,
    upn: claims?.upn ?? claims?.preferred_username,
    source: 'az-cli',
  }
}

function decodeJwtClaims(
  jwt: string,
): { oid?: string; upn?: string; preferred_username?: string } | null {
  const parts = jwt.split('.')
  if (parts.length < 2) return null
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4)
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

/**
 * Start a background refresh loop. Idempotent — calling twice replaces
 * the prior loop. Resolves with the first successful token so the
 * caller can fail fast on bad credentials.
 */
export async function startFoundryTokenRefresher(
  creds: FoundryCredentials,
  onRefresh?: (t: FoundryTokenResult) => void,
): Promise<FoundryTokenResult> {
  stopFoundryTokenRefresher()
  const token = await acquireFoundryToken(creds)
  if (onRefresh) onRefresh(token)
  scheduleNext(creds, token, onRefresh)
  return token
}

export function stopFoundryTokenRefresher(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

function scheduleNext(
  creds: FoundryCredentials,
  token: FoundryTokenResult,
  onRefresh?: (t: FoundryTokenResult) => void,
): void {
  const delay = Math.min(
    Math.max(token.expiresAt - Date.now() - REFRESH_LEAD_MS, 60_000),
    MAX_REFRESH_INTERVAL_MS,
  )
  timer = setTimeout(() => {
    void (async () => {
      try {
        inMemory = null
        const next = await acquireFoundryToken(creds)
        if (onRefresh) onRefresh(next)
        scheduleNext(creds, next, onRefresh)
      } catch {
        // Retry sooner on error.
        scheduleNext(
          creds,
          {
            accessToken: '',
            expiresAt: Date.now() + 60_000,
            source: 'cache',
          },
          onRefresh,
        )
      }
    })()
  }, delay)
  timer.unref?.()
}

/** Test-only: reset all module state. */
export function _resetFoundryAuthForTests() {
  inMemory = null
  if (timer) clearTimeout(timer)
  timer = null
  listeners = []
}
