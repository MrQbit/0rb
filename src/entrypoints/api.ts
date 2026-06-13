/**
 * REST + SSE API entrypoint for the ORB2 agent.
 *
 * Designed to run inside an ART agent pod where the eya-operator has
 * cloned `art-platform-secret` into a per-agent K8s Secret and mounts
 * it as envFrom. The pod sees `LLM_KEY`, `LLM_ENDPOINT`,
 * `LLM_DEPLOYMENT_NAME`, `LLM_VERSION`, `LLM_MODEL`, `LLM_PROVIDER`
 * pre-populated, plus `AGENT_ID`, `AGENT_PORT`, `ART_PLATFORM_URL`,
 * `ART_GATEWAY_URL`, `ART_LLM_ENDPOINT`, `ART_LLM_MODEL` from the
 * operator. We honour those automatically.
 *
 * Local dev / openwopr fallback: when LLM_KEY is unset but
 * ORB2_TENANT_ID + ORB2_CLIENT_ID are present, the legacy keyvault →
 * client_credentials → Foundry-route path is taken instead.
 *
 * Auth model: the API trusts its network boundary. Health, metadata,
 * and SPA static routes are anonymous; /v1/* requires a Bearer
 * `orb2_*` API key when `ORB2_API_AUTH_REQUIRED=1`. Inside a secure
 * cluster (default) every /v1/* call is allowed but identified as
 * `service:<agent-id>` for audit attribution.
 *
 * Bootstrap: when no admin key exists, an admin key is minted at
 * startup and printed to the pod logs ONCE. Use it to mint per-app
 * keys via the SPA's "API Keys" tab or POST /v1/keys.
 */
import { readFileSync, existsSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

if (!(globalThis as any).MACRO) {
  const __dir = dirname(fileURLToPath(import.meta.url))
  const pkgPath = join(__dir, '../../package.json')
  const pkg = existsSync(pkgPath)
    ? JSON.parse(readFileSync(pkgPath, 'utf8'))
    : { version: 'dev' }
  Object.assign(globalThis, {
    MACRO: {
      VERSION: pkg.version,
      DISPLAY_VERSION: pkg.version,
      PACKAGE_URL: 'orb2',
    },
  })
}

async function main() {
  // Worker / sandbox sub-modes were core entrypoints (./worker.js,
  // ./sandbox.js) removed in the re-platform off the previous engine
  // core. The API server is the only mode this entrypoint serves now.
  // RECOVERY TODO: re-add a sandbox/worker server on the agent core if
  // the RunCode/SubmitJob tools need an out-of-process executor again.

  // ─── Optional: keyvault bootstrap (legacy openwopr deployment) ───
  // When `ORB2_KEYVAULT_NAME` is set, fetch the Foundry SP creds
  // from Key Vault before the credential resolver runs. This keeps
  // the openwopr deployment working without any env changes; ART
  // deployments don't set ORB2_KEYVAULT_NAME so the block is skipped.
  if (process.env.ORB2_KEYVAULT_NAME) {
    const { loadKeyVaultSecrets } = await import('../api/foundry/keyvault.js')
    const map: Record<string, string> = {
      'ORB2-TENANT-ID': 'ORB2_TENANT_ID',
      'ORB2-CLIENT-ID': 'ORB2_CLIENT_ID',
      'ORB2-CLIENT-SECRET': 'ORB2_CLIENT_SECRET',
    }
    if (process.env.ORB2_KEYVAULT_SECRET_MAP) {
      for (const k of Object.keys(map)) delete map[k]
      for (const pair of process.env.ORB2_KEYVAULT_SECRET_MAP.split(',')) {
        const [secret, env] = pair.trim().split(':').map(s => s.trim())
        if (secret && env) map[secret] = env
      }
    }
    const names = Object.keys(map)
    console.log(
      `[api] Loading ${names.length} secret(s) from keyvault ${process.env.ORB2_KEYVAULT_NAME}: ${names.join(', ')}`,
    )
    const fetched = await loadKeyVaultSecrets(
      { vaultName: process.env.ORB2_KEYVAULT_NAME },
      names,
    )
    for (const [secretName, envName] of Object.entries(map)) {
      const v = fetched[secretName as keyof typeof fetched]
      if (v && !process.env[envName]) process.env[envName] = v
    }
    delete process.env.AZURE_CLIENT_SECRET
  }

  // ─── Resolve LLM credential ───
  // When ORB2_USE_FOUNDRY=1 the @anthropic-ai/foundry-sdk handles auth
  // directly via ANTHROPIC_FOUNDRY_API_KEY / ANTHROPIC_FOUNDRY_BASE_URL.
  // Skip the OpenAI-shim credential bootstrap so it doesn't clobber the
  // provider flag (ORB2_USE_OPENAI would shadow ORB2_USE_FOUNDRY).
  const useFoundry = (process.env.ORB2_USE_FOUNDRY ?? '').trim().toLowerCase()
  const isFoundry = ['1', 'true', 'yes', 'on'].includes(useFoundry)

  if (isFoundry) {
    // ─── Foundry endpoint normalization (single source of truth) ───
    //
    // The downstream Anthropic Foundry SDK and the OpenAI shim each
    // build URLs differently from the same logical endpoint, and the
    // SDKs have surprising behavior when given naked / partial URLs:
    //
    //   - @anthropic-ai/foundry-sdk literally appends "v1/messages"
    //     to whatever ANTHROPIC_FOUNDRY_BASE_URL it sees. If you pass
    //     "https://<res>.services.ai.azure.com" it POSTs to
    //     "/v1/messages" (no /anthropic/) → Azure 404 "Resource not
    //     found". When you instead pass `resource`, the SDK auto-
    //     builds "https://<res>.services.ai.azure.com/anthropic/" —
    //     the correct prefix.
    //
    //   - The OpenAI shim wants OPENAI_BASE_URL to point at
    //     "<root>/openai/v1" (Azure-style /openai/deployments/*
    //     routing).
    //
    // So we accept any ONE of these inputs and derive the rest:
    //   ANTHROPIC_FOUNDRY_RESOURCE=<short-name>     (preferred)
    //   ANTHROPIC_FOUNDRY_BASE_URL=https://...      (with or without /anthropic/)
    // and at boot we:
    //   1. Compute a canonical `root` URL (no /anthropic/ suffix).
    //   2. If only BASE_URL was provided, ensure it actually ends
    //      with /anthropic/ so the foundry SDK builds the right path.
    //      We unset RESOURCE in that case to avoid the SDK's
    //      mutual-exclusion check.
    //   3. If only RESOURCE was provided, leave it (the SDK will
    //      build /anthropic/ itself) and synthesize a `root` from it.
    //   4. Always derive OPENAI_BASE_URL from `root` + /openai/v1.
    //
    // Result: the chart and end users only have to set ONE of the
    // two upstream vars (or both, in which case BASE_URL wins) and
    // every downstream client lands on the right path.
    const explicitBase = (process.env.ANTHROPIC_FOUNDRY_BASE_URL || '').trim()
    const explicitResource = (process.env.ANTHROPIC_FOUNDRY_RESOURCE || '').trim()

    let root = ''
    if (explicitBase) {
      // Strip a trailing /anthropic[/...] to recover the resource root.
      root = explicitBase.replace(/\/anthropic\/?.*$/, '').replace(/\/+$/, '')
      // Always force baseUrl to end with /anthropic/ so the foundry
      // SDK's `baseURL + "v1/messages"` lands on /anthropic/v1/messages.
      const anthropicUrl = root + '/anthropic/'
      if (process.env.ANTHROPIC_FOUNDRY_BASE_URL !== anthropicUrl) {
        process.env.ANTHROPIC_FOUNDRY_BASE_URL = anthropicUrl
        console.log(`[api] Foundry: normalized ANTHROPIC_FOUNDRY_BASE_URL -> ${anthropicUrl}`)
      }
      // The SDK rejects baseURL + resource together; baseURL wins.
      if (process.env.ANTHROPIC_FOUNDRY_RESOURCE) {
        console.log('[api] Foundry: unsetting ANTHROPIC_FOUNDRY_RESOURCE (mutually exclusive with baseURL)')
        delete process.env.ANTHROPIC_FOUNDRY_RESOURCE
      }
    } else if (explicitResource) {
      // Let the SDK build the URL from RESOURCE; just synthesize the
      // root for OPENAI_BASE_URL derivation below.
      root = `https://${explicitResource}.services.ai.azure.com`
    }
    console.log(
      `[api] Foundry mode: endpoint=${root || '(unconfigured)'} ` +
      `anthropic=${process.env.ANTHROPIC_FOUNDRY_BASE_URL || `resource:${explicitResource}` || '(unset)'} ` +
      `model=${process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? '(default)'}`,
    )
    // Prevent the standalone bootstrap from starting a device-code flow.
    // It checks OPENAI_API_KEY to decide if credentials are already present.
    // Use the real Foundry key so OpenAI models on Foundry can authenticate
    // through the OpenAI shim (Azure Foundry hosts accept api-key header).
    if (!process.env.OPENAI_API_KEY) {
      process.env.OPENAI_API_KEY = process.env.ANTHROPIC_FOUNDRY_API_KEY || 'foundry-managed'
    }
    // Always derive OPENAI_BASE_URL from the canonical root so the
    // OpenAI shim's Azure /openai/deployments/* routing works whether
    // the chart was configured with resource or baseUrl.
    if (!process.env.OPENAI_BASE_URL && root) {
      process.env.OPENAI_BASE_URL = root + '/openai/v1'
      console.log(`[api] Foundry: derived OPENAI_BASE_URL -> ${process.env.OPENAI_BASE_URL}`)
    }
  } else {
    const { pickCredentialSource } = await import('../api/secrets/index.js')
    const source = await pickCredentialSource()
    console.log(`[api] Loading LLM credential via source=${source.name}`)
    const cred = await source.load()
    console.log(
      `[api] LLM ready: provider=${cred.provider} endpoint=${cred.endpoint} deployment=${cred.deploymentName} model=${cred.modelId} authMode=${cred.authMode}`,
    )

    // Mirror the credential into the openai-shim's expected env vars.
    process.env.OPENAI_API_KEY = cred.credential
    process.env.OPENAI_BASE_URL = cred.endpoint
    process.env.OPENAI_MODEL = cred.modelId
    process.env.AZURE_OPENAI_API_VERSION = cred.apiVersion
    process.env.ORB2_USE_OPENAI = '1'

    // Periodic refresh for sources that need it.
    const refreshMs = source.refreshAfterMs()
    if (refreshMs > 0) {
      setInterval(async () => {
        try {
          const fresh = await source.load()
          process.env.OPENAI_API_KEY = fresh.credential
        } catch (err) {
          console.error('[api] Credential refresh failed:', (err as Error).message)
        }
      }, refreshMs).unref?.()
    }
  }

  // ─── Init shared state ───
  // The legacy core's heavy init() (config system, telemetry, mTLS, proxy,
  // graceful shutdown, scratchpad) was removed in the re-platform. The API
  // reads its configuration straight from the environment, so no global init
  // is required for the self-hosted stack. RECOVERY TODO: re-add graceful
  // shutdown / config-file support on the agent core if needed.

  // ─── Ensure an admin/bootstrap key exists ───
  // Bootstrap admin minting is now done inside startApiServer via
  // bootstrapAdminKey() (auth/bootstrap.ts), seeded from the
  // ORB2_BOOTSTRAP_ADMIN_KEY env var (or the deprecated
  // ORB2_API_BOOTSTRAP_TOKEN alias). The legacy random-mint path
  // that printed the plaintext key to stdout has been removed.
  await ensureBootstrapAdminKey()

  // ─── Start API server ───
  const { startApiServer } = await import('../api/server.js')

  const port = parseInt(
    process.env.AGENT_PORT || process.env.ORB2_API_PORT || '8090',
    10,
  )
  const host = process.env.ORB2_API_HOST || '0.0.0.0'
  const webDirEnv = process.env.ORB2_API_WEB_DIR
  let webDir: string
  if (webDirEnv) {
    webDir = resolve(process.cwd(), webDirEnv)
  } else {
    // Try next to the bundle first (dist/web/), then CWD/web/
    const bundleDir = dirname(process.argv[1] || '.')
    const nextToBundle = resolve(bundleDir, 'web')
    const inCwd = resolve(process.cwd(), 'web')
    webDir = existsSync(nextToBundle) ? nextToBundle : existsSync(inCwd) ? inCwd : resolve(process.cwd(), 'src', 'web')
  }
  const agentId = process.env.AGENT_ID || 'orb2-api'

  // The core's background housekeeping (autoDream/MagicDocs/skillImprovement)
  // was removed in the re-platform. The API-side dream scheduler below covers
  // periodic memory consolidation for the orb.

  // Periodic memory consolidation ("dream"). The upstream autoDream gates off
  // filesystem session transcripts, which the API never writes (sessions live
  // in Redis), so it never fires — drive it on a timer instead.
  try {
    const { getStore } = await import('../api/store/store.js')
    const { startDreamScheduler } = await import('../api/memory/dream.js')
    startDreamScheduler(await getStore())
  } catch (err) {
    console.warn('[api] dream scheduler init failed:', (err as Error).message)
  }

  // Proactive home watcher — nudges the owner when a door/lock is left open.
  // No-op unless Home Assistant is configured + proactive is enabled.
  try {
    const { getStore } = await import('../api/store/store.js')
    const { startHomeWatcher } = await import('../api/home/proactive.js')
    startHomeWatcher(await getStore())
  } catch (err) {
    console.warn('[api] home watcher init failed:', (err as Error).message)
  }

  await startApiServer({
    port,
    host,
    agentId,
    webDir,
    sessionTtlSeconds: parseInt(
      process.env.ORB2_API_SESSION_TTL || '86400',
      10,
    ),
    maxConcurrentStreams: parseInt(
      process.env.ORB2_API_MAX_STREAMS || '100',
      10,
    ),
  })

  // Advertise on the LAN over mDNS so the 0rb Control Panel auto-discovers us.
  try {
    const { advertiseOrb } = await import('../api/discovery/mdns.js')
    advertiseOrb(port)
  } catch (err) {
    console.warn('[api] mdns advertise init failed:', (err as Error).message)
  }

  // ─── Start in-process job queue ───
  const { startPollLoop } = await import('../api/jobs/inprocQueue.js')
  startPollLoop()

  // ─── Heartbeat loop ───
  const { recordHeartbeat } = await import('../api/server.js')
  recordHeartbeat()
  let heartbeatLogCount = 0
  const heartbeatInterval = setInterval(() => {
    recordHeartbeat()
    heartbeatLogCount++
    if (heartbeatLogCount % 5 === 0) {
      console.log(`[api] heartbeat: ${new Date().toISOString()}`)
    }
  }, 60_000)
  heartbeatInterval.unref?.()

  // ─── Remote-control channels (optional, fully decoupled from boot) ───
  // WhatsApp / Telegram / ... are remote-control surfaces, not critical
  // startup steps. startChannels starts only configured channels and is
  // internally fire-and-forget per channel, so a slow/failed channel can
  // never delay the server becoming ready or block main() from returning.
  void (async () => {
    try {
      const { getStore } = await import('../api/store/store.js')
      const { startChannels } = await import('../api/channels/index.js')
      const chStore = await getStore()
      await startChannels(chStore)
    } catch (err) {
      console.warn('[api] channel startup failed (non-fatal):', (err as Error).message)
    }
  })()
}

/**
 * Mint an admin "bootstrap" key on first start. Writing the plaintext
 * to stdout (only on creation) lets the operator pull it from
 * `kubectl logs` to do the very first key-issuance call. Subsequent
 * starts find the existing record and stay quiet.
 *
 * `ORB2_API_BOOTSTRAP_TOKEN` (optional) lets ops pre-seed the
 * plaintext from a sealed Secret instead of relying on log scraping.
 */
async function ensureBootstrapAdminKey(): Promise<void> {
  // Forward the deprecated ORB2_API_BOOTSTRAP_TOKEN env var into the
  // canonical ORB2_BOOTSTRAP_ADMIN_KEY name so existing deployments
  // keep working. The actual bootstrap (idempotent, no stdout leak,
  // K8s-Secret-backed) runs inside startApiServer via
  // bootstrapAdminKey().
  const legacy = process.env.ORB2_API_BOOTSTRAP_TOKEN?.trim()
  if (legacy && !process.env.ORB2_BOOTSTRAP_ADMIN_KEY) {
    console.warn(
      '[api] ORB2_API_BOOTSTRAP_TOKEN is deprecated; rename to ORB2_BOOTSTRAP_ADMIN_KEY',
    )
    process.env.ORB2_BOOTSTRAP_ADMIN_KEY = legacy
  }

  // Single-user convenience: ORB2_OWNER_TOKEN doubles as the bootstrap
  // admin key so the operator only has to set one token.
  const ownerToken = process.env.ORB2_OWNER_TOKEN?.trim()
  if (ownerToken && !process.env.ORB2_BOOTSTRAP_ADMIN_KEY) {
    process.env.ORB2_BOOTSTRAP_ADMIN_KEY = ownerToken
    console.log('[api] ORB2_OWNER_TOKEN used as bootstrap admin key')
  }

  if (!process.env.ORB2_BOOTSTRAP_ADMIN_KEY) {
    if (process.env.ORB2_API_AUTH_REQUIRED !== '1') {
      console.warn(
        '[api] No ORB2_OWNER_TOKEN set. Running without auth locally is fine, ' +
        'but set ORB2_OWNER_TOKEN before exposing this instance remotely.',
      )
    } else {
      console.warn(
        '[api] ORB2_BOOTSTRAP_ADMIN_KEY not set; the cluster will start with NO admin key. ' +
        'Set ORB2_OWNER_TOKEN (or ORB2_BOOTSTRAP_ADMIN_KEY) on first deploy.',
      )
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
