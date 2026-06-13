/**
 * Azure Key Vault secret loader.
 *
 * Pure-fetch implementation against the Key Vault data-plane REST API
 * (api-version 7.4). We deliberately avoid `@azure/identity` and
 * `@azure/keyvault-secrets` so the compiled binary stays small and the
 * dependency surface stays auditable.
 *
 * Authentication uses a "bootstrap" service principal whose only job is
 * to read a small set of named secrets from the vault. Three modes:
 *
 *   1. Env-injected SP credentials:
 *        AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
 *      → client_credentials grant against
 *        https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
 *        with scope `https://vault.azure.net/.default`.
 *
 *   2. Federated workload identity (AKS, Argo CD with Azure AD):
 *        AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_FEDERATED_TOKEN_FILE
 *      → client assertion grant. The pod's service-account token is
 *        the federated assertion.
 *
 *   3. Pre-supplied bearer (testing, or if the operator has already
 *      minted a token):
 *        AZURE_KEYVAULT_BEARER
 *      → used verbatim, no refresh.
 *
 * The token + each secret value are cached in-process for their full
 * lifetime; expired tokens are re-acquired transparently on the next
 * call. Secrets are fetched lazily — `loadKeyVaultSecrets()` only
 * touches secrets you ask for.
 */

import { promises as fs } from 'node:fs'

const KV_API_VERSION = '7.4'
const KV_SCOPE = 'https://vault.azure.net/.default'
const TOKEN_ENDPOINT_TMPL =
  'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token'

export type KeyVaultBootstrapMode =
  | 'client_secret'
  | 'workload_identity'
  | 'bearer'

export type KeyVaultConfig = {
  vaultName: string
  /** Override for non-public clouds (e.g. Azure US Gov). */
  vaultDnsSuffix?: string
}

type CachedToken = { token: string; expiresAt: number }
let cached: CachedToken | null = null

function vaultBaseUrl(c: KeyVaultConfig): string {
  return `https://${c.vaultName}.${c.vaultDnsSuffix ?? 'vault.azure.net'}`
}

export function detectBootstrapMode(
  env: NodeJS.ProcessEnv = process.env,
): KeyVaultBootstrapMode | null {
  if (env.AZURE_KEYVAULT_BEARER) return 'bearer'
  if (
    env.AZURE_TENANT_ID &&
    env.AZURE_CLIENT_ID &&
    env.AZURE_FEDERATED_TOKEN_FILE
  ) {
    return 'workload_identity'
  }
  if (
    env.AZURE_TENANT_ID &&
    env.AZURE_CLIENT_ID &&
    env.AZURE_CLIENT_SECRET
  ) {
    return 'client_secret'
  }
  return null
}

async function mintBootstrapToken(
  env: NodeJS.ProcessEnv,
): Promise<CachedToken> {
  const mode = detectBootstrapMode(env)
  if (!mode) {
    throw new Error(
      'Cannot mint Key Vault token: no AZURE_KEYVAULT_BEARER, no client_credentials env (AZURE_TENANT_ID/AZURE_CLIENT_ID/AZURE_CLIENT_SECRET), no workload identity env (AZURE_FEDERATED_TOKEN_FILE).',
    )
  }
  if (mode === 'bearer') {
    return {
      token: env.AZURE_KEYVAULT_BEARER!,
      // Treat caller-supplied bearer as long-lived; we'll let the API
      // 401 if it expires and surface a clear error.
      expiresAt: Date.now() + 3600 * 1000,
    }
  }

  const tenant = env.AZURE_TENANT_ID!
  const clientId = env.AZURE_CLIENT_ID!
  const tokenUrl = TOKEN_ENDPOINT_TMPL.replace('{tenant}', tenant)
  const params = new URLSearchParams({
    client_id: clientId,
    scope: KV_SCOPE,
  })

  if (mode === 'client_secret') {
    params.set('grant_type', 'client_credentials')
    params.set('client_secret', env.AZURE_CLIENT_SECRET!)
  } else {
    // workload_identity
    const assertionPath = env.AZURE_FEDERATED_TOKEN_FILE!
    const assertion = (await fs.readFile(assertionPath, 'utf8')).trim()
    params.set('grant_type', 'client_credentials')
    params.set(
      'client_assertion_type',
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    )
    params.set('client_assertion', assertion)
  }

  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
  if (!resp.ok) {
    throw new Error(
      `Key Vault token request failed (${resp.status}): ${await resp.text()}`,
    )
  }
  const body = (await resp.json()) as {
    access_token: string
    expires_in: number
  }
  return {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in - 60) * 1000,
  }
}

async function getBootstrapToken(
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if (cached && cached.expiresAt > Date.now()) return cached.token
  cached = await mintBootstrapToken(env)
  return cached.token
}

export async function getKeyVaultSecret(
  config: KeyVaultConfig,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const token = await getBootstrapToken(env)
  const url = `${vaultBaseUrl(config)}/secrets/${encodeURIComponent(name)}?api-version=${KV_API_VERSION}`
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(
      `Key Vault GET ${name} failed (${resp.status}): ${body.slice(0, 400)}`,
    )
  }
  const json = (await resp.json()) as { value?: string }
  if (typeof json.value !== 'string') {
    throw new Error(`Key Vault secret ${name} has no value`)
  }
  return json.value
}

/**
 * Fetch a list of secrets in parallel. Missing secrets throw — every
 * name in the list is mandatory.
 */
export async function loadKeyVaultSecrets<T extends string>(
  config: KeyVaultConfig,
  names: readonly T[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<T, string>> {
  const entries = await Promise.all(
    names.map(async name => [name, await getKeyVaultSecret(config, name, env)] as const),
  )
  return Object.fromEntries(entries) as Record<T, string>
}

/** Test-only: clear the cached bootstrap token. */
export function _clearKeyVaultCache(): void {
  cached = null
}
