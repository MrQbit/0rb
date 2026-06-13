/**
 * Pluggable LLM credential source.
 *
 * Three sources, picked by `ORB2_SECRET_SOURCE`:
 *
 *   - `env`   — read directly from process.env. Used when running in
 *               the ART platform: the eya-operator clones
 *               `art-platform-secret` into a per-agent K8s Secret and
 *               mounts it as envFrom, so `LLM_KEY`, `LLM_ENDPOINT`,
 *               `LLM_DEPLOYMENT_NAME`, `LLM_VERSION`, `LLM_MODEL`,
 *               `LLM_PROVIDER` all arrive pre-populated.
 *
 *   - `azure-kv` — legacy. Bootstrap SP fetches `ORB2-TENANT-ID`,
 *                  `ORB2-CLIENT-ID`, `ORB2-CLIENT-SECRET` from a Key
 *                  Vault and Foundry tokens are minted via
 *                  client_credentials. Kept for back-compat with the
 *                  openwopr deployment and for emergency rollback.
 *
 *   - `auto`  — env first, fall back to azure-kv if env vars missing.
 *               Default.
 *
 * Both backends produce the same `ResolvedLlmCredential` shape so the
 * Foundry client doesn't care where the credential came from.
 */
export type LlmAuthMode = 'api-key' | 'bearer-token'

export type ResolvedLlmCredential = {
  /** How upstream auth header is formed: api-key header vs Bearer. */
  authMode: LlmAuthMode
  /** Header value: API key (api-key) or access token (bearer-token). */
  credential: string
  /** Endpoint host without trailing slash. */
  endpoint: string
  /** Azure OpenAI deployment name (e.g. "gpt-4o"). */
  deploymentName: string
  /** Azure OpenAI API version. */
  apiVersion: string
  /** Model id (often == deploymentName for Azure OpenAI). */
  modelId: string
  /** Provider tag for logs / metadata. */
  provider: string
  /** Optional: when the credential expires (ms epoch); undefined for static api-key. */
  expiresAt?: number
}

export type CredentialSource = {
  name: 'env' | 'azure-kv'
  load(): Promise<ResolvedLlmCredential>
  /** Refresh hint in ms. -1 means static (api-key) — never refresh. */
  refreshAfterMs(): number
}

export async function pickCredentialSource(): Promise<CredentialSource> {
  const choice = (process.env.ORB2_SECRET_SOURCE ?? 'auto').toLowerCase()
  if (choice === 'env') return loadEnvSource()
  if (choice === 'azure-kv' || choice === 'azurekv') return loadAzureKvSource()
  // auto
  if (process.env.LLM_KEY && process.env.LLM_ENDPOINT) {
    return loadEnvSource()
  }
  return loadAzureKvSource()
}

function loadEnvSource(): CredentialSource {
  return {
    name: 'env',
    async load(): Promise<ResolvedLlmCredential> {
      const need = (k: string) => {
        const v = process.env[k]
        if (!v) throw new Error(`env source: ${k} is required`)
        return v
      }
      const endpointRaw = need('LLM_ENDPOINT')
      const endpoint = endpointRaw.replace(/\/+$/, '')
      const cred: ResolvedLlmCredential = {
        authMode: 'api-key',
        credential: need('LLM_KEY'),
        endpoint,
        deploymentName: need('LLM_DEPLOYMENT_NAME'),
        apiVersion: process.env.LLM_VERSION ?? '2025-01-01-preview',
        modelId: process.env.LLM_MODEL ?? need('LLM_DEPLOYMENT_NAME'),
        provider: process.env.LLM_PROVIDER ?? 'azure_openai',
      }
      return cred
    },
    refreshAfterMs() {
      // Static api-key — no rotation logic needed at this layer.
      // (When the operator rotates the platform secret, the pod
      // restarts and we pick up the new value on next load.)
      return -1
    },
  }
}

function loadAzureKvSource(): CredentialSource {
  return {
    name: 'azure-kv',
    async load(): Promise<ResolvedLlmCredential> {
      // Lazy import so the env-source path doesn't pull
      // `@azure/identity` and `@azure/keyvault-secrets` into the
      // hot start path when they're not used.
      const { startFoundryTokenRefresher } = await import('../foundry/foundryAuth.js')
      const tenantId = process.env.ORB2_TENANT_ID
      const clientId = process.env.ORB2_CLIENT_ID
      if (!tenantId || !clientId) {
        throw new Error(
          'azure-kv source: ORB2_TENANT_ID + ORB2_CLIENT_ID required (load via keyvault bootstrap before calling pickCredentialSource)',
        )
      }
      const token = await startFoundryTokenRefresher(
        {
          tenantId,
          clientId,
          clientSecret: process.env.ORB2_CLIENT_SECRET,
          clientAssertion: process.env.ORB2_CLIENT_ASSERTION,
        },
        () => {
          /* token refresher writes to OPENAI_API_KEY directly */
        },
      )
      // Legacy Foundry deployment endpoint/model now come from env (the
      // core's curated FOUNDRY_DEPLOYMENTS registry was removed in the
      // re-platform). Operators using azure-kv must set LLM_ENDPOINT +
      // LLM_DEPLOYMENT_NAME (as the env source already requires).
      const baseUrl = (process.env.LLM_ENDPOINT || process.env.OPENAI_BASE_URL || '').replace(/\/+$/, '')
      if (!baseUrl) {
        throw new Error(
          'azure-kv source: LLM_ENDPOINT (or OPENAI_BASE_URL) is required to derive the Foundry endpoint',
        )
      }
      const endpoint = baseUrl.replace(/\/openai(\/v1)?\/?$/, '')
      const deploymentName = process.env.LLM_DEPLOYMENT_NAME || process.env.LLM_MODEL || 'gpt-4o'
      return {
        authMode: 'bearer-token',
        credential: token.accessToken,
        endpoint,
        deploymentName,
        apiVersion: process.env.LLM_VERSION || '2025-01-01-preview',
        modelId: process.env.LLM_MODEL || deploymentName,
        provider: process.env.LLM_PROVIDER || 'azure_openai',
        expiresAt: token.expiresAt,
      }
    },
    refreshAfterMs() {
      // Foundry tokens last ~1h; refresh proactively at 50min.
      return 50 * 60 * 1000
    },
  }
}
