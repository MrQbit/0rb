/**
 * ORB2 REST API server.
 *
 * Routes:
 *   - Public: /healthz, /readyz, /metrics, /openapi.json, /docs (Swagger)
 *   - Static SPA: /, /web/*, /docs/integration
 *   - Service info: GET /v1/info, GET /v1/agent/well-known
 *   - Keys: GET/POST /v1/keys, DELETE /v1/keys/{id}
 *   - Catalog: GET /v1/models, GET /v1/tools
 *   - Chat: POST /v1/chat (sync), POST /v1/chat/stream (SSE)
 *   - Sessions: GET /v1/sessions, GET/DELETE /v1/sessions/{id}
 *   - Audit: GET /v1/audit (admin)
 *
 * Auth model: Bearer `orb2_*` API keys + an ambient `service`
 * identity used inside trusted clusters (controlled by
 * `ORB2_API_AUTH_REQUIRED`).
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { runAgentTurn, runAgentTurnWithFallback, type AgentRunHooks } from './agentRunner.js'
import { buildApiNativeTools, apiNativeToolDefs } from './tools/apiNativeTools.js'
import { agentContextPrompt } from './agentContext.js'
import { trySpotifyOAuthRoute } from './connectors/spotifyRoutes.js'
import { tryCloudOAuthRoute } from './connectors/cloudStorageRoutes.js'
import { tryDockerRoute } from './connectors/dockerRoutes.js'
import { tryTailscaleRoute } from './connectors/tailscaleRoutes.js'
import { tryWidgetRegistryRoute } from './widgets/registryRoutes.js'
import { routeTurn } from './modelRouter.js'
import { buildFallbackChain } from './foundry/fallbackChain.js'
import { getDefaultMcpServers } from './mcp/defaultServers.js'
import {
  isCanvasModeEnabled,
  getCanvasPod,
  createCanvasPod,
  destroyCanvasPod,
} from './canvas/dispatch.js'
import { matchPreviewRoute, handlePreviewProxy } from './canvas/proxy.js'
import type { CanvasTemplate } from './canvas/types.js'
import { DEFAULT_CANVAS_CONFIG } from './canvas/types.js'
import { getStore, type Store } from './store/store.js'
import { mintApiKey } from './auth/apiKey.js'
import { safeJoinUnderWorkspace, isWorkspaceEscape } from './fs/workspacePath.js'
import { bootstrapAdminKey } from './auth/bootstrap.js'
import { checkRateLimit, rateLimitedResponse, isRateLimitEnabled } from './control/rateLimit.js'
import { parseBody } from './schemas/parseBody.js'
import { CreateKeyRequest } from './schemas/keys.js'
import { ToolInvokeRequest } from './schemas/tools.js'
import {
  resolveIdentity,
  resolveServiceIdentity,
  isAdmin,
  attributionFor,
  type CallerIdentity,
} from './auth/context.js'
import { handleAuthRoutes } from './auth/routes.js'
import {
  authEnabled, verifySession, parseCookies, SESSION_COOKIE, signSession, ensureSessionSecret,
} from './auth/session.js'
import { buildOpenApiSpec, SWAGGER_HTML } from './openapi.js'
import { createSse, SSE_RESPONSE_HEADERS } from './sse.js'
import { log, createAuditEmitter } from './log.js'
import { metrics } from './metrics.js'
import { cleanToolDefs } from './toolProvider.js'
import { handleA2aRpc } from './a2a.js'
import { JobManager } from './jobs/manager.js'
import { executeSubmitJob, getJobManager, SUBMIT_JOB_TOOL_DEF } from './jobs/tool.js'
import { connectRabbit, publishToFabric, isRabbitConnected } from './jobs/rabbit.js'
import { startRequestConsumer } from './jobs/requestConsumer.js'
import { executeRunCode, RUN_CODE_TOOL_DEF, isSandboxEnabled } from './sandbox/tool.js'
import type { FabricMessageEnvelope } from './jobs/types.js'
import { getVaultStore, executeVaultRead, executeVaultWrite, executeVaultSearch } from './vault/tools.js'
import { getVaultClient, getSecretFromVault, putSecretToVault, deleteSecretFromVault } from './secrets/vault.js'
import { initRelayReporter, getRelayReporter, type InstanceInfo } from './relay/reporter.js'
import { classifyIntent, renderHint } from './agent/intentHint.js'
import { tryHandleBridgeRoute } from './internal/bridgeRoutes.js'
import { listCommands, getCommand } from './commands/registry.js'
import { tryHandleMcpRoute } from './mcp/routes.js'
import { tryHandlePolicyRoute } from './policy/routes.js'
import { loadPolicy as loadTopicPolicy } from './policy/topicPolicy.js'
import { evaluateTopicPolicy } from './policy/evaluate.js'
import { tryHandleMemoryRoute } from './memory/routes.js'
import { tryHandleCostRoute, recordCostPoint, dollars } from './cost/routes.js'
import { tryHandleSandboxRoute } from './sandbox/routes.js'
import {
  initKillSwitch,
  getControlState,
  getLocal,
  getRelay,
  setLocalState,
  type ControlState,
} from './control/killSwitch.js'
import {
  initFeatureFlags,
  isSkillsEnabled,
  getAllFeatureFlags,
  setSkillsEnabled,
} from './features/flags.js'
import {
  tryHandleObservabilityRoute,
  isTurnAborted,
} from './observability/routes.js'
import { tryHandleDiscoveryRoute } from './discovery/routes.js'
import { listUserMcpServers } from './mcp/userServers.js'
import {
  startDiscoveryWorker,
  getDiscoveredAgents,
  getDiscoveredMcps,
  getDiscoveredSkills,
} from './discovery/registry.js'
import {
  listDynamicAgents,
  createDynamicAgent,
  deleteDynamicAgent,
  reconcileFsAgents,
} from './agents/dynamic.js'
import { tryHandleFilesRoute } from './files/routes.js'
import { tryHandleWhatsAppRoute } from './whatsapp/routes.js'
import { tryHandleVoiceRoute } from './voice/routes.js'
import { isVoiceWsRequest, makeVoiceWsData, voiceWebSocketHandlers } from './voice/websocket.js'
import { tryHandleChannelsRoute } from './channels/routes.js'
import { tryHandleClusterRoute } from './cluster/routes.js'
import { tryHandleHomeRoute } from './home/routes.js'
import { tryHandleSetupRoute, setupRequired, isClaimedCached, announceSetupIfNeeded } from './setup/routes.js'
import { tryHandlePushRoute } from './push/routes.js'
import { tryHandleOAuthRelayRoute } from './oauth/relayRoutes.js'
import { getFileMeta as filesGetMeta } from './files/storage.js'
import { mintInstallationToken as mintGitHubAppToken } from './github/appAuth.js'
import {
  saveGitHubUserToken,
  loadGitHubUserToken,
  deleteGitHubUserToken,
  fetchGitHubUserProfile,
} from './github/userTokens.js'
import {
  requestDeviceCode as ghRequestDeviceCode,
  pollAccessToken as ghPollAccessToken,
  getGithubDeviceFlowClientId,
} from './github/deviceFlow.js'
import type {
  AgentPaletteEntry,
  McpPaletteEntry,
  SkillPaletteEntry,
} from './workerDispatch.js'

const SERVER_BOOT_TIME = Date.now()
let _lastHeartbeatAt: string | null = null

export function recordHeartbeat(): void {
  _lastHeartbeatAt = new Date().toISOString()
}

/**
 * Snapshot the current agent + MCP + skill palette so the worker can
 * materialize the union (built-in + dynamic + discovered) before
 * runAgentTurn. Discovered MCPs become a synthesized .mcp.json the
 * standard loaders pick up; discovered skills hydrate the in-memory
 * registry so matchSkill() in the worker sees the same set of skills
 * as the router.
 */
async function buildWorkerPalettes(store: Store): Promise<{
  agentPalette: AgentPaletteEntry[]
  mcpPalette: McpPaletteEntry[]
  skillsPalette: SkillPaletteEntry[]
}> {
  const agentPalette: AgentPaletteEntry[] = []
  try {
    const dyn = await listDynamicAgents(store)
    for (const a of dyn) {
      agentPalette.push({
        id: a.id,
        name: a.name,
        description: a.description,
        prompt: a.prompt,
        tools: a.tools,
        model: a.model,
        source: 'dynamic',
      })
    }
  } catch { /* dynamic registry optional */ }
  try {
    for (const a of getDiscoveredAgents()) {
      agentPalette.push({
        id: a.id,
        name: a.name,
        description: a.description,
        prompt: a.prompt,
        tools: a.tools,
        model: a.model,
        source: 'discovered',
      })
    }
  } catch { /* discovery optional */ }
  const mcpPalette: McpPaletteEntry[] = []
  try {
    for (const m of getDiscoveredMcps()) {
      mcpPalette.push({
        name: m.name,
        config: m.config,
        source: 'discovered',
      })
    }
  } catch { /* discovery optional */ }
  const skillsPalette: SkillPaletteEntry[] = []
  try {
    for (const s of getDiscoveredSkills()) {
      skillsPalette.push({
        name: s.name,
        description: s.description,
        instructions: s.instructions,
        source: 'discovered',
      })
    }
  } catch { /* discovery optional */ }
  return { agentPalette, mcpPalette, skillsPalette }
}

/**
 * Build a short-lived github.com credential for the worker pod's git
 * credential helper. Resolution order:
 *
 *   1. Per-user OAuth token (device flow). When the caller is signed
 *      in via POST /v1/auth/github/device/*, that token is the one
 *      `git push` should use so commits are attributed to the user.
 *   2. GitHub App installation token. Service identity / unauthenticated
 *      callers still get the App's installation token so internal
 *      automation continues to work.
 *
 * Returns undefined when neither is configured; the worker simply
 * skips the git credential helper injection and behaves the same as
 * before. Failures are logged and swallowed so a bad config never
 * blocks a chat turn.
 */
async function buildGitCredentials(
  store: Store | undefined,
  oid: string | undefined,
): Promise<
  | {
      host: string
      username: string
      password: string
      expiresAt: string
    }
  | undefined
> {
  if (store && oid) {
    try {
      const userTok = await loadGitHubUserToken(store, oid)
      if (userTok?.token) {
        return {
          host: 'github.com',
          // GitHub accepts the bare OAuth token as the password when the
          // username is the login or 'x-access-token'. We use the login
          // so server-side audit logs reflect the actual user.
          username: userTok.login || 'x-access-token',
          password: userTok.token,
          // OAuth tokens have no fixed expiry; the worker's apply-and-
          // forget credential helper just uses the value verbatim.
          expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
        }
      }
    } catch { /* fall through to App token */ }
  }
  try {
    const tok = await mintGitHubAppToken()
    if (!tok) return undefined
    return {
      host: 'github.com',
      username: 'x-access-token',
      password: tok.token,
      expiresAt: tok.expiresAt,
    }
  } catch {
    return undefined
  }
}
import {
  isWorkerModeEnabled,
  getWorkerStats,
  launchWorkerJob,
  subscribeToWorker,
} from './workerDispatch.js'
import { randomUUID as _wd_randomUUID } from 'node:crypto'
import { maybeExtractMemories } from './vault/extractor.js'
import { maybeCompactSession } from './vault/compactor.js'
import { runConsolidation, shouldConsolidate } from './vault/consolidator.js'
import { serializeSkill, writeSkillFile, deleteSkillFile, readSkillRaw, disabledSkillKey, type SkillInput } from './skills/writer.js'
import { isSkillDisabled, setSkillDisabled, loadDisabledSkills } from './skills/registry.js'

// ────────────── GitHub user sign-in (OAuth device flow) ──────────────
//
// All four handlers require an authenticated caller (apikey or service
// identity). The device_code returned from /start is the only piece
// the caller sends back to /poll; we do NOT echo the access_token to
// the client by default — it stays server-side, attached to the
// caller's oid, and is consumed by buildGitCredentials() the next
// time the worker dispatches a git operation. External callers that
// want to hold the token themselves can pass `return_token: true` to
// the poll endpoint to get a one-shot copy in the response body.

async function handleGithubDeviceStart(
  _req: Request,
  identity: CallerIdentity,
  ctx: RuntimeContext,
): Promise<Response> {
  const oid = attributionFor(identity).oid
  if (!oid) {
    return jsonResponse(401, { error: 'oid required to bind GitHub credentials' })
  }
  // Operators must register a GitHub OAuth App for their deployment
  // and set GITHUB_DEVICE_FLOW_CLIENT_ID. The default value baked
  // into the codebase is the public Claude-Code CLI client, which is
  // not authorized for our deployment and will 404 here.
  if (!process.env.GITHUB_DEVICE_FLOW_CLIENT_ID?.trim()) {
    return jsonResponse(503, {
      error:
        'GitHub sign-in is not configured. Set GITHUB_DEVICE_FLOW_CLIENT_ID ' +
        'to the client ID of an OAuth App with the device flow enabled.',
      code: 'GH_DEVICE_NOT_CONFIGURED',
      docs: 'https://docs.github.com/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow',
    })
  }
  try {
    const code = await ghRequestDeviceCode({
      clientId: getGithubDeviceFlowClientId(),
    })
    // Stash the device_code → oid mapping so /poll can verify the
    // caller is the same identity that started the flow (defence in
    // depth — the device code itself is sufficient at GitHub's API,
    // but we tie it to the API-key owner so a leaked device code can't
    // be used to bind to another user's session).
    await ctx.store.putKv(`orb2:github:device:${code.device_code}`, oid, 900)
    return jsonResponse(200, {
      device_code: code.device_code,
      user_code: code.user_code,
      verification_uri: code.verification_uri,
      expires_in: code.expires_in,
      interval: code.interval,
    })
  } catch (err) {
    return jsonResponse(502, {
      error: `GitHub device flow start failed: ${(err as Error).message}`,
      code: 'GH_DEVICE_START',
    })
  }
}

async function handleGithubDevicePoll(
  req: Request,
  identity: CallerIdentity,
  ctx: RuntimeContext,
): Promise<Response> {
  const oid = attributionFor(identity).oid
  if (!oid) {
    return jsonResponse(401, { error: 'oid required to bind GitHub credentials' })
  }
  const body = (await safeJson(req)) as
    | { device_code?: string; return_token?: boolean }
    | null
  const deviceCode = body?.device_code?.trim()
  if (!deviceCode) {
    return jsonResponse(400, { error: 'device_code is required' })
  }
  const boundOid = await ctx.store.getKv(`orb2:github:device:${deviceCode}`)
  if (!boundOid || boundOid !== oid) {
    return jsonResponse(403, {
      error: 'device_code does not belong to this caller',
      code: 'GH_DEVICE_MISMATCH',
    })
  }
  try {
    // pollAccessToken loops internally. We give it a short timeout
    // (3s) so the HTTP request returns quickly with `pending` and the
    // caller drives the next poll. This keeps the request loop snappy
    // for the SPA and any third-party caller.
    const token = await ghPollAccessToken(deviceCode, {
      clientId: getGithubDeviceFlowClientId(),
      timeoutSeconds: 3,
      initialInterval: 1,
    }).catch(err => {
      const msg = (err as Error).message || ''
      if (/Timed out|authorization_pending/i.test(msg)) {
        return null
      }
      throw err
    })
    if (!token) {
      return jsonResponse(200, { pending: true })
    }
    const profile = await fetchGitHubUserProfile(token)
    const login = profile?.login || ''
    if (!login) {
      return jsonResponse(502, {
        error: 'GitHub /user lookup returned no login',
        code: 'GH_PROFILE_FAILED',
      })
    }
    // Persist server-side and clear the device-code key.
    await saveGitHubUserToken(ctx.store, oid, {
      token,
      login,
      scopes: ['read:user'],
      granted_at: new Date().toISOString(),
      name: profile?.name,
      email: profile?.email,
    })
    await ctx.store.delKv(`orb2:github:device:${deviceCode}`)
    return jsonResponse(200, {
      pending: false,
      login,
      scopes: ['read:user'],
      name: profile?.name,
      email: profile?.email,
      ...(body?.return_token === true && { access_token: token }),
    })
  } catch (err) {
    return jsonResponse(502, {
      error: `GitHub device flow poll failed: ${(err as Error).message}`,
      code: 'GH_DEVICE_POLL',
    })
  }
}

async function handleGithubStatus(
  _req: Request,
  identity: CallerIdentity,
  ctx: RuntimeContext,
): Promise<Response> {
  const oid = attributionFor(identity).oid
  if (!oid) {
    return jsonResponse(200, { logged_in: false })
  }
  const rec = await loadGitHubUserToken(ctx.store, oid)
  if (!rec) return jsonResponse(200, { logged_in: false })
  return jsonResponse(200, {
    logged_in: true,
    login: rec.login,
    scopes: rec.scopes,
    granted_at: rec.granted_at,
    name: rec.name,
    email: rec.email,
  })
}

async function handleGithubLogout(
  _req: Request,
  identity: CallerIdentity,
  ctx: RuntimeContext,
): Promise<Response> {
  const oid = attributionFor(identity).oid
  if (!oid) return jsonResponse(200, { logged_in: false })
  await deleteGitHubUserToken(ctx.store, oid)
  return jsonResponse(200, { logged_in: false })
}

export type ApiServerConfig = {
  port: number
  host: string
  /** Agent identifier (env AGENT_ID) used for service-identity attribution. */
  agentId: string
  /** Path to compiled SPA static dir. */
  webDir: string
  /** Default session TTL in seconds. */
  sessionTtlSeconds: number
  /** Hard cap on concurrent SSE streams; 0 disables. */
  maxConcurrentStreams: number
}

function injectGitCredentials(url: string, login: string, secret: string): string {
  const user = encodeURIComponent(login)
  const pass = encodeURIComponent(secret)
  const credBlock = [user, pass].join(':')
  const proto = 'https://'
  return url.replace(/^https:\/\//i, proto + credBlock + '@')
}

export async function startApiServer(config: ApiServerConfig) {
  const store = await getStore()
  const audit = createAuditEmitter(store)

  await ensureSessionSecret(store)
  await bootstrapAdminKey(store)
  await announceSetupIfNeeded(store)

  log.info('api_starting', {
    port: config.port,
    host: config.host,
    agent: config.agentId,
    redis: process.env.REDIS_URL ? 'on' : 'memory',
    auth_required: process.env.ORB2_API_AUTH_REQUIRED === '1',
  })

  const openApiSpec = buildOpenApiSpec({
    version: process.env.ORB2_API_VERSION || 'dev',
    agentId: config.agentId,
  })

  const Bun = (globalThis as any).Bun
  if (!Bun?.serve) {
    throw new Error('API server must run under Bun (Bun.serve missing)')
  }

  const handler = (req: Request) =>
    handleRequest(req, { ...config, store, audit, openApiSpec })

  const maxBodyMb = Number(process.env.ORB2_API_MAX_BODY_MB ?? 4)
  const voiceWs = voiceWebSocketHandlers(store)
  const serveOpts: any = {
    hostname: config.host,
    port: config.port,
    // Bun's default is 10s, which prematurely closes long SSE streams
    // (LLM turns can sit idle for >10s between tool_start/tool_result
    // frames, killing the client connection with "network error" even
    // though the agent is still running). Max permitted is 255s.
    idleTimeout: 255,
    // Cap arbitrary body sizes to bound DoS via large payloads.
    // File-upload routes parse the multipart stream themselves
    // so they're capped separately at the upload-handler layer.
    maxRequestBodySize: Math.max(1, maxBodyMb) * 1024 * 1024,
    fetch(req: Request, srv: { upgrade: (req: Request, opts?: unknown) => boolean }) {
      // Upgrade the voice socket before falling through to HTTP routing.
      if (process.env.ORB2_VOICE_ENABLED === '1') {
        const reqUrl = new URL(req.url)
        const { pathname } = reqUrl
        if (isVoiceWsRequest(pathname)) {
          // Gate the voice socket behind the session when auth is on — the
          // browser sends the cookie on the upgrade; the iOS app sends a
          // Bearer session token. Without this, voice would bypass auth.
          if (authEnabled()) {
            const a = req.headers.get('authorization') ?? ''
            let token = /^Bearer\s+/i.test(a) ? a.replace(/^Bearer\s+/i, '').trim() : ''
            if (!token) token = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE] ?? ''
            if (!verifySession(token)) return new Response('unauthorized', { status: 401 })
          }
          // Share the caller's chat session (?session=) so voice + text have
          // one unified memory; fall back to a fresh voice session.
          if (srv.upgrade(req, { data: makeVoiceWsData(reqUrl.searchParams.get('session')) })) return undefined
          return new Response('expected websocket', { status: 426 })
        }
      }
      return handler(req)
    },
    websocket: voiceWs,
    error(err: Error) {
      log.error('unhandled_request_error', { error: err.message })
      return new Response(
        JSON.stringify({ error: 'Internal server error', code: 'INTERNAL' }),
        {
          status: 500,
          headers: { 'content-type': 'application/json' },
        },
      )
    },
  }
  const server = Bun.serve(serveOpts)

  log.info('api_listening', { url: `http://${config.host}:${config.port}` })

  // Load persisted settings from store (vault → redis → env)
  ;(async () => {
    try {
      const vaultClient = getVaultClient()
      if (vaultClient) {
        const healthy = await vaultClient.healthCheck()
        log.info('vault_init', { addr: process.env.VAULT_ADDR, healthy })
      }
      for (const key of SETTINGS_KEYS) {
        if (process.env[key]) continue // env already set (e.g. from K8s Secret)
        // Try vault first, then redis
        let val: string | null = null
        if (vaultClient) {
          try { val = await getSecretFromVault(key) } catch { /* vault miss, try redis */ }
        }
        if (!val) val = await store.getKv(`${SETTINGS_KV_PREFIX}${key}`)
        if (val) process.env[key] = val
      }
      if (process.env.RABBITMQ_URL) {
        const ok = await connectRabbit()
        if (ok) {
          startRequestConsumer({ store, sessionTtlSeconds: config.sessionTtlSeconds })
            .catch(err => log.warn('rabbit_consumer_failed', { error: (err as Error).message }))
        }
      }
      // Load disabled skill states from Redis
      await loadDisabledSkills(store)

      // Bridge embedded .md skills into the SDK's bundled-skill
      // registry so they're visible to the agent's SkillTool
      // regardless of cwd. Must run BEFORE startDiscoveryWorker so
      // bundled skills are registered before any discovery-driven
      // skill listing builds its cache.
      try {
        const { bootstrapEmbeddedSkills } = await import('./skills/bootstrap.js')
        await bootstrapEmbeddedSkills()
      } catch (err) {
        log.warn('embedded_skills_bootstrap_failed', { error: (err as Error).message })
      }

      // Boot discovery worker (skills/MCPs/agents from configured EMU
      // repos, allowlisted to the private GitHub org). No-op when
      // ORB2_DISCOVERY_PATHS is empty.
      startDiscoveryWorker()

      // Re-index dynamic agents from the FS mirror (ORB2_AGENT_FS_ROOT).
      // No-op when the env var is unset; otherwise re-populates Redis
      // entries that were lost on a fresh data directory.
      reconcileFsAgents(store).catch(err => {
        log.warn('dynamic_agent_reconcile_failed', { error: (err as Error).message })
      })

      // Phase 4: kill-switch state machine. Recovers persisted local
      // override + last-known relay state from Redis, then polls every
      // 10s. Heartbeat ACKs from the relay also push state in.
      await initKillSwitch(store)

      // Phase 6: runtime feature flags. Today only `skills`. Booted
      // from ORB2_SKILLS_ENABLED env, runtime override in Redis.
      await initFeatureFlags(store)
      log.info('feature_flags_loaded', getAllFeatureFlags())

      // Start relay reporter if configured
      const relayUrl = process.env.ORB2_RELAY_URL
      if (relayUrl) {
        const reporter = initRelayReporter({
          relayUrl,
          eventSecret: process.env.ORB2_RELAY_EVENT_SECRET || '',
          instanceId: process.env.ORB2_INSTANCE_ID,
        })
        // Models may not be probed yet; start with empty, heartbeat will update
        const info: InstanceInfo = {
          instanceId: '',
          agentId: config.agentId,
          version: process.env.ORB2_API_VERSION || 'dev',
          startedAt: new Date().toISOString(),
          models: [],
          workerMode: process.env.ORB2_WORKER_MODE ?? 'in-process',
          environment: process.env.ORB2_ENVIRONMENT || 'dev',
          secretSource: getVaultClient() ? 'vault' : 'redis',
          features: { thinking: true, activity: true, vault: !!getVaultClient(), workers: isWorkerModeEnabled() },
        }
        await reporter.start(store, info)
        log.info('relay_reporter_configured', { relayUrl })

        // Periodic memory digest sync (opt-in via ORB2_RELAY_MEMORY_SYNC=true)
        if (reporter.isMemorySyncEnabled()) {
          const collectDigest = async () => {
            try {
              const vault = getVaultStore(store)
              const notes = await vault.list()
              // Index entries don't carry full body sizes; use snippet length as a proxy.
              const approxBytes = notes.reduce((s, n) => s + (n.snippet?.length ?? 0), 0)
              const tags = Array.from(new Set(notes.flatMap(n => n.tags ?? []))).slice(0, 100)
              reporter.recordMemoryDigest({
                note_count: notes.length,
                total_bytes: approxBytes,
                tags,
              })
            } catch (err) {
              log.warn('relay_memory_digest_failed', { error: (err as Error).message })
            }
          }
          collectDigest().catch(() => {})
          setInterval(() => { collectDigest().catch(() => {}) }, 60_000).unref?.()
        }

        // Periodic dashboard snapshot — same payload the console shows,
        // so HQ sees the same numbers per instance. Push every 60s.
        const pushDashboard = async () => {
          try {
            const { buildDashboardSnapshot } = await import('./relay/dashboardSnapshot.js')
            const workerStats = isWorkerModeEnabled()
              ? await getWorkerStats(store).catch(() => null)
              : null
            const snap = await buildDashboardSnapshot({
              store,
              workerMode: process.env.ORB2_WORKER_MODE ?? 'in-process',
              defaultModel: process.env.OPENAI_MODEL ?? null,
              workerStats: workerStats as any,
              redisOk: await store.ping().catch(() => false),
              vaultOk: getVaultClient() ? await getVaultClient()!.healthCheck().catch(() => false) : null,
            })
            if (snap) reporter.recordDashboardSnapshot(snap)
          } catch (err) {
            log.warn('relay_dashboard_snapshot_failed', { error: (err as Error).message })
          }
        }
        // Fire one immediately so HQ has a baseline; subsequent ticks
        // are bounded by setInterval.
        pushDashboard().catch(() => {})
        setInterval(() => { pushDashboard().catch(() => {}) }, 60_000).unref?.()
      }
    } catch (err) {
      log.warn('settings_init_failed', { error: (err as Error).message })
    }
  })()

  const stop = () => {
    log.info('api_shutting_down')
    server.stop?.()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  return server
}

type RuntimeContext = ApiServerConfig & {
  store: Store
  audit: ReturnType<typeof createAuditEmitter>
  openApiSpec: Record<string, unknown>
}

function corsHeaders(req: Request): Record<string, string> {
  const allowed = process.env.ORB2_CORS_ORIGINS || ''
  if (!allowed) return {}
  const origin = req.headers.get('origin') || ''
  if (!origin) return {}
  const allowList = allowed === '*' ? ['*'] : allowed.split(',').map(s => s.trim())
  if (allowList.includes('*') || allowList.includes(origin)) {
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'access-control-allow-headers': 'Content-Type, Authorization',
      'access-control-max-age': '86400',
    }
  }
  return {}
}

async function handleRequest(
  req: Request,
  ctx: RuntimeContext,
): Promise<Response> {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    const ch = corsHeaders(req)
    return new Response(null, { status: 204, headers: ch })
  }

  const url = new URL(req.url)
  const startedAt = Date.now()
  let status = 200
  try {
    const res = await dispatch(req, url, ctx)
    status = res.status
    const ch = corsHeaders(req)
    for (const [k, v] of Object.entries(ch)) res.headers.set(k, v)
    return res
  } catch (err) {
    status = 500
    log.error('handler_threw', {
      route: `${req.method} ${url.pathname}`,
      error: (err as Error).message,
    })
    return jsonResponse(500, {
      error: (err as Error).message || 'Internal server error',
      code: 'INTERNAL',
    })
  } finally {
    metrics.recordHttp(
      sanitizeRouteLabel(url.pathname),
      status,
      (Date.now() - startedAt) / 1000,
    )
  }
}

function normalizeRoute(p: string): string {
  if (p.length > 1 && p.endsWith('/')) return p.slice(0, -1)
  return p
}

function sanitizeRouteLabel(p: string): string {
  return p
    .replace(/\/v1\/sessions\/[^/]+/, '/v1/sessions/{id}')
    .replace(/\/v1\/keys\/[^/]+/, '/v1/keys/{id}')
}

// Phase 4: chat / file-upload / agent-mutation surfaces consult the
// kill switch and return 503 when an operator has flipped state to
// `disabled` (or, for new sessions, `draining`). Health, info,
// /v1/relay/status, /v1/control* and read-only listings stay open so
// the pod can still pass probes and the operator can resume.
function gateForChat(): Response | null {
  const c = getControlState()
  if (c.state === 'disabled') {
    return jsonResponse(503, {
      error: `chat surface disabled (source: ${c.source})`,
      code: 'ORB2_DISABLED',
      reason: c.reason ?? null,
    })
  }
  if (c.state === 'draining') {
    return jsonResponse(503, {
      error: 'instance is draining; in-flight turns will finish, no new turns accepted',
      code: 'ORB2_DRAINING',
      reason: c.reason ?? null,
    })
  }
  return null
}

// Phase 3: tool args/results stay LOCAL. Only a SHA-256 of the
// stringified arguments is forwarded to the relay so we can correlate
// 'same call ran twice' without leaking secrets, file contents, or
// repo paths. The full payload remains in the local audit log.
function hashToolArgs(args: unknown): string {
  try {
    const s = typeof args === 'string' ? args : JSON.stringify(args ?? null)
    // Lightweight hash; not security-sensitive — just a correlation
    // handle. Avoids importing crypto at the top of this file.
    let h = 0xcbf29ce484222325n
    for (let i = 0; i < s.length; i++) {
      h ^= BigInt(s.charCodeAt(i))
      h = (h * 0x100000001b3n) & 0xffffffffffffffffn
    }
    return h.toString(16).padStart(16, '0')
  } catch {
    return ''
  }
}

async function dispatch(
  req: Request,
  url: URL,
  ctx: RuntimeContext,
): Promise<Response> {
  const pathname = normalizeRoute(url.pathname)
  const method = req.method

  // ─────────── Public ───────────
  if (method === 'GET' && pathname === '/healthz') {
    return jsonResponse(200, { ok: true, agent: ctx.agentId })
  }

  // Published pages — PUBLIC (no auth) so they can be shared with non-users.
  // Served from <workspace>/.published/<id>/. CDN libs allowed (relaxed CSP).
  const pubMatch = /^\/v1\/pub\/([a-z0-9]{6,12})(\/.*)?$/.exec(pathname)
  if (method === 'GET' && pubMatch) {
    const id = pubMatch[1]!
    let sub = pubMatch[2] || '/'
    if (sub === '/' || sub === '') sub = '/index.html'
    const wsRoot = process.env.ORB2_API_WORKSPACE_ROOT || '/workspace'
    const { join, normalize } = await import('node:path')
    const base = normalize(join(wsRoot, '.published', id))
    const filePath = normalize(join(base, sub))
    if (!filePath.startsWith(base)) return jsonResponse(403, { error: 'forbidden' })
    try {
      const { readFile } = await import('node:fs/promises')
      const buf = await readFile(filePath)
      const ext = (filePath.split('.').pop() || '').toLowerCase()
      const ct = ext === 'html' ? 'text/html; charset=utf-8' : ext === 'js' ? 'text/javascript' : ext === 'css' ? 'text/css'
        : ext === 'json' ? 'application/json' : ext === 'svg' ? 'image/svg+xml' : ext === 'png' ? 'image/png'
        : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'application/octet-stream'
      const headers: Record<string, string> = { 'content-type': ct, 'cache-control': 'public, max-age=120' }
      if (ext === 'html') {
        headers['content-security-policy'] = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://esm.sh https://unpkg.com; style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://fonts.googleapis.com; img-src * data: blob:; font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net; connect-src *; frame-src https://www.youtube.com https://open.spotify.com https://sketchfab.com; object-src 'none'"
      }
      return new Response(buf, { status: 200, headers })
    } catch { return jsonResponse(404, { error: 'published page not found' }) }
  }

  // Spotify OAuth (connect account + control). Handles its own auth: the
  // callback is public (Spotify redirect), the rest require a session.
  const spRoute = await trySpotifyOAuthRoute(req, method, pathname, ctx.store)
  if (spRoute) return spRoute

  // Cloud Storage OAuth (Google Drive + OneDrive). Callback is public; the rest
  // require a session (handled inside).
  const cloudRoute = await tryCloudOAuthRoute(req, method, pathname, ctx.store)
  if (cloudRoute) return cloudRoute

  // Docker widget control (list + stop/start/restart/pull), session-gated.
  const dockerRoute = await tryDockerRoute(req, method, pathname)
  if (dockerRoute) return dockerRoute

  // Tailscale remote-access control for the Access panel, session-gated.
  const tsRoute = await tryTailscaleRoute(req, method, pathname)
  if (tsRoute) return tsRoute

  // Widget registry (Settings → Apps): list + on/off toggle, session-gated.
  const wgRoute = await tryWidgetRegistryRoute(req, method, pathname, ctx.store)
  if (wgRoute) return wgRoute

  // WhatsApp bridge inbound webhook. Authenticated by a shared secret (the
  // bridge service holds the WhatsApp Web session and the allowlist), so it
  // bypasses the normal session-auth gate. Runs an agent turn for the sender
  // and returns the reply for the bridge to send back over WhatsApp.
  if (method === 'POST' && pathname === '/v1/channels/whatsapp/inbound') {
    const secret = process.env.ORB2_WHATSAPP_BRIDGE_SECRET || ''
    if (!secret || req.headers.get('x-bridge-secret') !== secret) {
      return jsonResponse(401, { error: 'bad bridge secret' })
    }
    let body: any = {}
    try { body = await req.json() } catch { /* */ }
    const from = String(body?.from || '').replace(/\D/g, '')
    const text = String(body?.text || '').trim()
    if (!from || !text) return jsonResponse(400, { error: 'from and text required' })
    try {
      const { runChannelTurn } = await import('./channels/runtime.js')
      const reply = await runChannelTurn({
        text,
        sessionId: `whatsapp:${from}`,
        ownerId: `whatsapp:${from}`,
        store: ctx.store,
      })
      return jsonResponse(200, { reply })
    } catch (err) {
      log.error('whatsapp_inbound_failed', { error: (err as Error).message })
      return jsonResponse(500, { error: (err as Error).message })
    }
  }
  if (method === 'GET' && pathname === '/readyz') {
    const redisOk = await ctx.store.ping()
    const vaultOk = getVaultClient() ? await getVaultClient()!.healthCheck() : null
    const workerStats = isWorkerModeEnabled() ? await getWorkerStats(ctx.store) : null
    return jsonResponse(redisOk ? 200 : 503, {
      ok: redisOk,
      redis: redisOk,
      vault: vaultOk,
      active_streams: metrics.activeStreams(),
      workers: workerStats,
    })
  }
  if (method === 'GET' && pathname === '/metrics') {
    return new Response(metrics.render(), {
      status: 200,
      headers: { 'content-type': 'text/plain; version=0.0.4' },
    })
  }
  if (method === 'GET' && pathname === '/v1/dashboard') {
    const { buildDashboardSnapshot } = await import('./relay/dashboardSnapshot.js')
    const workerStats = isWorkerModeEnabled() ? await getWorkerStats(ctx.store).catch(() => null) : null
    const snap = await buildDashboardSnapshot({
      store: ctx.store,
      workerMode: process.env.ORB2_WORKER_MODE ?? 'in-process',
      defaultModel: process.env.OPENAI_MODEL ?? null,
      workerStats: workerStats as any,
      redisOk: await ctx.store.ping().catch(() => false),
      vaultOk: getVaultClient() ? await getVaultClient()!.healthCheck().catch(() => false) : null,
    })
    return jsonResponse(200, snap)
  }
  if (method === 'GET' && pathname === '/openapi.json') {
    return jsonResponse(200, ctx.openApiSpec)
  }
  if (method === 'GET' && (pathname === '/docs' || pathname === '/docs/')) {
    return new Response(SWAGGER_HTML, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  }
  if (method === 'GET' && pathname === '/docs/integration') {
    // SPA moved to orb2-ui (https://github.com/orb2-core-ui).
    // Keep the route present so any external link doesn't 404 — it now
    // returns a small redirect hint pointing the operator at the UI host.
    if (ctx.webDir && existsSync(ctx.webDir + '/integration.html')) {
      return serveStatic(ctx.webDir, 'integration.html')
    }
    return new Response(
      'The integration guide is served by orb2-ui (open / on the UI host).',
      { status: 410, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    )
  }
  if (method === 'GET' && (pathname === '/docs/readme.md' || pathname === '/docs/architecture.md')) {
    const fname = pathname === '/docs/readme.md' ? 'README.md' : 'ARCHITECTURE.md'
    const searchPaths = [
      path.join(process.cwd(), fname),
      path.join(path.dirname(process.argv[1] || ''), fname),
      path.join(path.dirname(process.argv[1] || ''), '..', fname),
      path.join('/opt/orb2-api', fname),
    ]
    for (const fp of searchPaths) {
      try {
        const { readFileSync } = await import('node:fs')
        const content = readFileSync(fp, 'utf-8')
        return new Response(content, {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        })
      } catch { /* try next */ }
    }
    return new Response('# Not Found\n\nDocumentation file not bundled in this build.', {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }
  if (
    method === 'GET' &&
    (pathname === '/.well-known/agent.json' || pathname === '/.well-known/agent-card.json')
  ) {
    return jsonResponse(200, buildAgentCard(ctx))
  }
  // SPA used to be served by this process from /, /index.html, and
  // /web/*. Those routes were moved to a dedicated orb2-ui nginx pod
  // in v0.3.0. If the operator still mounts a SPA build at
  // ctx.webDir (legacy single-pod mode) we keep serving it so existing
  // deployments don't break; otherwise we return a small JSON hint
  // pointing at the UI host.
  if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    if (ctx.webDir && existsSync(ctx.webDir + '/index.html')) {
      return serveStatic(ctx.webDir, 'index.html')
    }
    return jsonResponse(200, {
      name: 'orb2-api',
      message:
        'The console SPA is served by orb2-ui (separate pod). This is the API process.',
      docs: '/docs',
      openapi: '/openapi.json',
      info: '/v1/info',
    })
  }
  if (method === 'GET' && pathname.startsWith('/web/')) {
    if (ctx.webDir && existsSync(ctx.webDir + '/' + pathname.slice('/web/'.length))) {
      return serveStatic(ctx.webDir, pathname.slice('/web/'.length))
    }
    return new Response('SPA moved to orb2-ui', { status: 410 })
  }

  // ─────────── First-run setup / claim ───────────
  // The claim endpoints are always reachable; everything else on /v1 is locked
  // (423) until the owner claims an unclaimed instance.
  const setupResp = await tryHandleSetupRoute(method, pathname, req, ctx.store)
  if (setupResp) return setupResp
  if (
    setupRequired() &&
    pathname.startsWith('/v1/') &&
    !pathname.startsWith('/v1/setup') &&
    pathname !== '/v1/info' &&
    !(await isClaimedCached(ctx.store))
  ) {
    return jsonResponse(423, { error: 'This 0rb is not set up yet', code: 'NEEDS_SETUP', needs_setup: true })
  }

  // ─────────── Worker bridge (HMAC-authenticated, no apikey identity) ───────────
  if (pathname.startsWith('/v1/internal/turn/')) {
    const bridgeResp = await tryHandleBridgeRoute(req, pathname, {
      store: ctx.store,
      audit: e => ctx.audit({ ...e, oid: 'worker-bridge', keyId: undefined } as any),
    })
    if (bridgeResp) return bridgeResp
  }

  // ─────────── Resolve identity for /v1/* ───────────
  let identity: CallerIdentity | null = await resolveIdentity(req, ctx.store)
  if (!identity) {
    identity = resolveServiceIdentity(ctx.agentId)
  }

  // Per-identity rate limiting on write-heavy/expensive routes.
  if (identity && isRateLimitEnabled()) {
    const rl = await checkRateLimit(ctx.store, identity, method, pathname)
    if (rl.allowed === false) {
      return rateLimitedResponse(rl.retryAfterMs, rl.remaining, rl.bucket)
    }
  }

  // Public catalog endpoints — visible without identity in
  // service-trust mode; per-key allowlists still apply when a Bearer
  // is present.
  if (method === 'GET' && pathname === '/v1/status') {
    return handleStatus(ctx)
  }
  if (method === 'GET' && pathname === '/v1/info') {
    return handleInfo(ctx)
  }
  if (method === 'GET' && pathname === '/v1/models') {
    return await handleListModels(identity)
  }
  if (method === 'POST' && pathname === '/v1/models/reprobe') {
    return await handleReprobeModels()
  }
  if (method === 'POST' && pathname === '/v1/models/healthcheck') {
    return await handleHealthCheck(ctx)
  }
  if (method === 'GET' && pathname === '/v1/tools') {
    return handleListTools(identity)
  }
  if (method === 'GET' && pathname === '/v1/skills') {
    if (!isSkillsEnabled()) {
      // Empty list (rather than 503) so the Console can still call
      // it and render an empty state without raising errors. The
      // top-level feature flag is what tells the UI to hide the tab.
      return jsonResponse(200, { skills: [], feature_disabled: true })
    }
    const { getAllSkills } = await import('./skills/registry.js')
    const skills = getAllSkills().map(s => ({
      name: s.name,
      description: s.description,
      keywords: s.keywords || '',
      enabled: !isSkillDisabled(s.name),
      mcp_servers: s.mcpServers.map(m => ({ name: m.name, url: m.url, transport: m.transport })),
    }))
    return jsonResponse(200, { skills })
  }
  // Skill CRUD. All mutations are blocked when the feature is off so
  // a client running with skills disabled cannot accidentally repopulate
  // the skills directory by mistake. Reads still 404 cleanly.
  const skillNameMatch = pathname.match(/^\/v1\/skills\/([a-z0-9-]+)$/)
  if (skillNameMatch) {
    const skillName = skillNameMatch[1]!
    if (!isSkillsEnabled() && method !== 'GET') {
      return jsonResponse(503, {
        error: 'skills feature disabled for this deployment',
        code: 'ORB2_SKILLS_DISABLED',
      })
    }
    if (method === 'GET') {
      if (!isSkillsEnabled()) return jsonResponse(404, { error: 'not found' })
      return handleGetSkill(skillName)
    }
    if (method === 'PUT') {
      return await handleUpdateSkill(skillName, req, ctx)
    }
    if (method === 'DELETE') {
      return handleDeleteSkill(skillName, ctx)
    }
  }
  if (method === 'POST' && pathname === '/v1/skills') {
    if (!isSkillsEnabled()) {
      return jsonResponse(503, {
        error: 'skills feature disabled for this deployment',
        code: 'ORB2_SKILLS_DISABLED',
      })
    }
    return await handleCreateSkill(req, ctx)
  }
  // Skill enable/disable
  const skillToggleMatch = pathname.match(/^\/v1\/skills\/([a-z0-9-]+)\/(enable|disable)$/)
  if (skillToggleMatch && method === 'POST') {
    if (!isSkillsEnabled()) {
      return jsonResponse(503, {
        error: 'skills feature disabled for this deployment',
        code: 'ORB2_SKILLS_DISABLED',
      })
    }
    return await handleToggleSkill(skillToggleMatch[1]!, skillToggleMatch[2]! as 'enable' | 'disable', ctx)
  }
  // ─── Phase 6: feature flags ───
  // GET is open (the Console reads it on every page load); POST is
  // admin-only. Each transition emits a `feature.changed` audit event
  // that flows to the relay through the Phase 3 forwarder.
  if (method === 'GET' && pathname === '/v1/features') {
    return jsonResponse(200, getAllFeatureFlags())
  }
  if (method === 'POST' && pathname === '/v1/features/skills') {
    // Admin gating dropped (Phase 8) — any authenticated caller can flip
    // feature flags. RBAC will be reintroduced once Entra/AAD lands.
    let body: { enabled?: boolean; reason?: string } = {}
    try { body = (await req.json()) as { enabled?: boolean; reason?: string } } catch { /* allow empty */ }
    if (typeof body.enabled !== 'boolean') {
      return jsonResponse(400, { error: 'enabled (boolean) is required' })
    }
    const before = isSkillsEnabled()
    const after = await setSkillsEnabled(body.enabled, body.reason, attributionFor(identity).oid)
    if (before !== body.enabled) {
      ctx.audit({
        ...attributionFor(identity),
        event: 'feature.changed',
        data: {
          feature: 'skills',
          from: before,
          to: body.enabled,
          reason: body.reason ?? null,
        },
      })
    }
    return jsonResponse(200, after)
  }

  // ─── Job routes ───
  if (method === 'POST' && pathname === '/v1/jobs') {
    return await handleCreateJob(req, identity!, ctx)
  }
  if (method === 'GET' && pathname === '/v1/jobs') {
    return await handleListJobs(identity!, ctx)
  }
  const jobMatch = pathname.match(/^\/v1\/jobs\/([\w-]+)$/)
  if (jobMatch && method === 'GET') {
    return await handleGetJob(jobMatch[1]!, ctx)
  }
  if (jobMatch && method === 'DELETE') {
    return await handleCancelJob(jobMatch[1]!, ctx)
  }
  const jobApproveMatch = pathname.match(/^\/v1\/jobs\/([\w-]+)\/approve$/)
  if (jobApproveMatch && method === 'POST') {
    return await handleApproveJob(jobApproveMatch[1]!, ctx)
  }
  const jobRejectMatch = pathname.match(/^\/v1\/jobs\/([\w-]+)\/reject$/)
  if (jobRejectMatch && method === 'POST') {
    return await handleRejectJob(jobRejectMatch[1]!, ctx)
  }
  if (method === 'GET' && pathname === '/v1/integrations/status') {
    return handleIntegrationsStatus()
  }
  // ─── Vault routes ───
  if (method === 'GET' && pathname === '/v1/vault') {
    return await handleVaultList(ctx)
  }
  if (method === 'GET' && pathname === '/v1/vault/search') {
    const q = new URL(req.url).searchParams.get('q') || ''
    const tags = new URL(req.url).searchParams.get('tags')?.split(',').filter(Boolean)
    return await handleVaultSearch(q, tags, ctx)
  }
  const vaultNoteMatch = pathname.match(/^\/v1\/vault\/note\/(.+)$/)
  if (vaultNoteMatch) {
    const notePath = decodeURIComponent(vaultNoteMatch[1]!)
    if (method === 'GET') return await handleVaultRead(notePath, ctx)
    if (method === 'PUT') return await handleVaultWrite(notePath, req, ctx)
    if (method === 'DELETE') return await handleVaultDelete(notePath, ctx)
  }
  if (method === 'POST' && pathname === '/v1/vault/rebuild-index') {
    return await handleVaultRebuildIndex(ctx)
  }
  if (method === 'POST' && pathname === '/v1/vault/consolidate') {
    return await handleVaultConsolidate(req, ctx)
  }
  if (method === 'GET' && pathname === '/v1/vault/consolidate/status') {
    return await handleVaultConsolidateStatus(ctx)
  }

  // Public username/password auth endpoints (login/logout/me) — must be
  // reachable before the identity gate below.
  {
    const authResp = await handleAuthRoutes(req, method, pathname, ctx.store)
    if (authResp) return authResp
  }

  // From here on: identity required.
  if (!identity) {
    return jsonResponse(401, {
      error: 'Authentication required',
      code: 'UNAUTHENTICATED',
    })
  }

  if (method === 'GET' && pathname === '/v1/whoami') {
    return jsonResponse(200, identitySummary(identity))
  }

  // A/V ingest: the remote camera stream pushes its latest frame here; it's
  // held in memory only, keyed by the owner identity (single-user). The
  // agent's Vision tool reads the same key.
  if (method === 'POST' && pathname === '/v1/av/frame') {
    const owner = attributionFor(identity).oid || 'owner'
    const buf = new Uint8Array(await req.arrayBuffer())
    if (!buf.length) return jsonResponse(400, { error: 'empty frame' })
    const { setFrame } = await import('./vision/vision.js')
    setFrame(owner, buf)
    // Also store under the shared 'owner' key so a VOICE turn (whose Vision
    // tool is keyed by the session id, not the identity) still sees the frame.
    if (owner !== 'owner') setFrame('owner', buf)
    return jsonResponse(200, { ok: true, bytes: buf.length })
  }
  // The persisted memory of what orb2 has seen.
  if (method === 'GET' && pathname === '/v1/av/sightings') {
    const owner = attributionFor(identity).oid || 'owner'
    const { recentSightings } = await import('./vision/vision.js')
    return jsonResponse(200, { sightings: await recentSightings(ctx.store, owner) })
  }
  // A short bearer the WebRTC client passes to the av-webrtc service so it
  // can push frames as this user (the session cookie is HttpOnly).
  if (method === 'GET' && pathname === '/v1/av/token') {
    const name = identity.type === 'user' ? identity.username : (attributionFor(identity).oid || 'owner')
    return jsonResponse(200, { token: signSession(name, 3600) })
  }

  // GitHub OAuth device flow — sign-in for personal git operations.
  if (method === 'POST' && pathname === '/v1/auth/github/device/start') {
    return handleGithubDeviceStart(req, identity, ctx)
  }
  if (method === 'POST' && pathname === '/v1/auth/github/device/poll') {
    return handleGithubDevicePoll(req, identity, ctx)
  }
  if (method === 'GET' && pathname === '/v1/auth/github/status') {
    return handleGithubStatus(req, identity, ctx)
  }
  if (method === 'POST' && pathname === '/v1/auth/github/logout') {
    return handleGithubLogout(req, identity, ctx)
  }

  if (method === 'GET' && pathname === '/v1/keys') {
    return handleListKeys(identity, ctx)
  }
  if (method === 'POST' && pathname === '/v1/keys') {
    return handleCreateKey(req, identity, ctx)
  }
  const keyMatch = /^\/v1\/keys\/([A-Za-z0-9-]+)$/.exec(pathname)
  if (method === 'DELETE' && keyMatch) {
    return handleRevokeKey(keyMatch[1]!, identity, ctx)
  }

  if (method === 'GET' && pathname === '/v1/settings') {
    return handleGetSettings(ctx)
  }
  if (method === 'PUT' && pathname === '/v1/settings') {
    return handlePutSettings(req, identity, ctx)
  }
  const settingDeleteMatch = method === 'DELETE' && pathname.match(/^\/v1\/settings\/(.+)$/)
  if (settingDeleteMatch) {
    return handleDeleteSetting(decodeURIComponent(settingDeleteMatch[1]!), identity, ctx)
  }

  if (method === 'POST' && pathname === '/v1/chat') {
    const gate = gateForChat()
    if (gate) return gate
    return handleChat(req, identity, ctx, false)
  }
  if (method === 'POST' && pathname === '/v1/chat/stream') {
    const gate = gateForChat()
    if (gate) return gate
    return handleChat(req, identity, ctx, true)
  }
  // Direct tool invocation. Routes through the agent loop forcing a
  // single tool call so every registered tool works without
  // re-implementing the tool harness. Identity-gated.
  const toolInvokeMatch = pathname.match(/^\/v1\/tools\/([A-Za-z0-9_-]+)\/invoke$/)
  if (method === 'POST' && toolInvokeMatch) {
    return handleToolInvoke(toolInvokeMatch[1]!, req, identity, ctx)
  }

  // Slash-command-as-REST. Each command is a templated chat turn.
  if (method === 'GET' && pathname === '/v1/commands') {
    return jsonResponse(200, {
      commands: listCommands().map(c => ({
        name: c.name,
        description: c.description,
        args_schema: c.args_schema,
        long_running: c.long_running === true,
      })),
    })
  }
  const cmdMatch = pathname.match(/^\/v1\/commands\/([a-z0-9-]+)$/)
  if (cmdMatch && method === 'POST') {
    return handleCommand(cmdMatch[1]!, req, identity, ctx)
  }

  // Sub-agent registry: list (open) + create/delete (admin-gated).
  if (method === 'GET' && pathname === '/v1/agents') {
    return handleListAgents(ctx)
  }
  if (method === 'POST' && pathname === '/v1/agents') {
    return handleCreateAgent(req, identity, ctx)
  }
  const agentDeleteMatch = method === 'DELETE' && pathname.match(/^\/v1\/agents\/([^/]+)$/)
  if (agentDeleteMatch) {
    return handleDeleteAgent(decodeURIComponent(agentDeleteMatch[1]!), identity, ctx)
  }

  // External sub-worker dispatch (identity-gated mirror of the
  // bridge /workers/spawn endpoint). Lets a client launch a
  // parallel worker turn without going through chat.
  if (method === 'POST' && pathname === '/v1/workers/spawn') {
    return handleSpawnWorker(req, identity, ctx)
  }

  if (method === 'GET' && pathname === '/v1/sessions') {
    return handleListSessions(identity, ctx)
  }
  const sessMatch = /^\/v1\/sessions\/([A-Za-z0-9_-]+)$/.exec(pathname)
  if (sessMatch) {
    if (method === 'GET') return handleGetSession(sessMatch[1]!, identity, ctx)
    if (method === 'DELETE')
      return handleDeleteSession(sessMatch[1]!, identity, ctx)
  }

  if (method === 'GET' && pathname === '/v1/audit') {
    return handleAudit(url, identity, ctx)
  }

  // ─────────── A2A JSON-RPC ───────────
  // /a2a is the canonical JSON-RPC endpoint.
  // A2A v0.3 REST-style paths (also used by agentgateway proxies).
  if (
    method === 'POST' &&
    (pathname === '/a2a' || pathname === '/message/send' || pathname === '/message/stream')
  ) {
    return handleA2aRpc(req, identity, ctx)
  }

  // ─── Phase 3: MCP / memory / cost / sandbox / policy pass-throughs ───
  const mcpResp = await tryHandleMcpRoute(req, pathname, identity, ctx)
  if (mcpResp) return mcpResp
  const policyResp = await tryHandlePolicyRoute(req, pathname, identity, {
    store: ctx.store,
    audit: (e) => ctx.audit({ ...attributionFor(identity), ...e }),
  })
  if (policyResp) return policyResp
  const memResp = await tryHandleMemoryRoute(req, pathname, identity, ctx)
  if (memResp) return memResp
  const costResp = await tryHandleCostRoute(req, pathname, ctx)
  if (costResp) return costResp
  // ─── Phase 2: relay registration status ───
  if (req.method === 'GET' && pathname === '/v1/relay/status') {
    const r = getRelayReporter()
    if (!r) {
      return jsonResponse(200, {
        enabled: false,
        status: 'unconfigured',
        instance_id: null,
        relay_url: process.env.ORB2_RELAY_URL || null,
        last_beat_at: null,
        registered_at: null,
        error: null,
      })
    }
    return jsonResponse(200, r.getStatus())
  }
  if (req.method === 'POST' && pathname === '/v1/relay/register') {
    const r = getRelayReporter()
    if (!r) {
      return jsonResponse(503, { error: 'relay not configured', code: 'RELAY_UNCONFIGURED' })
    }
    const ok = await r.forceRegister()
    return jsonResponse(ok ? 200 : 502, r.getStatus())
  }
  // ─── Phase 4: kill-switch ───
  if (req.method === 'GET' && pathname === '/v1/control') {
    return jsonResponse(200, {
      effective: getControlState(),
      local: getLocal(),
      relay: getRelay(),
    })
  }
  const ctlMatch = pathname.match(/^\/v1\/control\/(disable|drain|resume)$/)
  if (req.method === 'POST' && ctlMatch) {
    const action = ctlMatch[1] as 'disable' | 'drain' | 'resume'
    const target: ControlState =
      action === 'disable' ? 'disabled' : action === 'drain' ? 'draining' : 'active'
    let body: { reason?: string } = {}
    try { body = (await req.json()) as { reason?: string } } catch { /* allow empty body */ }
    const before = getControlState()
    const after = await setLocalState(target, body.reason, attributionFor(identity).oid)
    ctx.audit({
      ...attributionFor(identity),
      event: 'control.state_changed',
      data: {
        from: before.state,
        to: after.state,
        action,
        source: 'local',
        reason: body.reason ?? null,
      },
    })
    return jsonResponse(200, { local: after, effective: getControlState() })
  }
  const sandResp = await tryHandleSandboxRoute(req, pathname)
  if (sandResp) return sandResp
  // ─── Canvas preview proxy (k8s canvas pods) ───
  const previewMatch = matchPreviewRoute(pathname)
  if (previewMatch) {
    return handlePreviewProxy(req, previewMatch.sessionId, previewMatch.subpath, ctx.store, identity)
  }
  // ─── Workspace file serving (canvas in-process mode) ───
  const wsMatch = /^\/v1\/workspace\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(pathname)
  if (method === 'GET' && wsMatch) {
    const wsSid = wsMatch[1]!
    const wsPath = (wsMatch[2] || '/index.html').replace(/^\/+/, '')
    const wsRoot = process.env.ORB2_API_WORKSPACE_ROOT || '/workspace'
    const resolved = path.resolve(path.join(wsRoot, wsSid), wsPath)
    if (!resolved.startsWith(path.resolve(wsRoot, wsSid))) {
      return jsonResponse(403, { error: 'Path traversal' })
    }
    try {
      const { readFileSync } = await import('node:fs')
      const content = readFileSync(resolved)
      const ext = path.extname(resolved).toLowerCase()
      const MIME: Record<string, string> = {
        '.html': 'text/html', '.htm': 'text/html',
        '.js': 'text/javascript', '.mjs': 'text/javascript',
        '.jsx': 'text/javascript', '.tsx': 'text/javascript',
        '.ts': 'text/javascript',
        '.css': 'text/css', '.json': 'application/json',
        '.svg': 'image/svg+xml', '.png': 'image/png',
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.ico': 'image/x-icon',
        '.woff': 'font/woff', '.woff2': 'font/woff2',
        '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
      }
      return new Response(content, {
        status: 200,
        headers: {
          'content-type': MIME[ext] || 'application/octet-stream',
          'X-Frame-Options': 'SAMEORIGIN',
          'Cache-Control': 'no-cache',
        },
      })
    } catch {
      return jsonResponse(404, { error: 'File not found' })
    }
  }
  // ─── Canvas git endpoints ───
  // POST /v1/canvas/{sid}/git/init        — force-initialise repo
  // GET  /v1/canvas/{sid}/git/status      — branch / head / remote
  // POST /v1/canvas/{sid}/git/remote      — attach origin, optionally push
  const canvasGitMatch = /^\/v1\/canvas\/([A-Za-z0-9_-]+)\/git\/(init|status|remote)$/.exec(pathname)
  if (canvasGitMatch) {
    const gitSid = canvasGitMatch[1]!
    const op = canvasGitMatch[2]!
    const wsRoot = process.env.ORB2_API_WORKSPACE_ROOT || '/workspace'
    const cwd = path.resolve(path.join(wsRoot, gitSid))
    if (!cwd.startsWith(path.resolve(wsRoot))) {
      return jsonResponse(403, { error: 'Path traversal' })
    }
    const { ensureCanvasGitRepo, canvasGitStatus, attachRemoteAndPush } =
      await import('./canvas/git.js')
    const { mkdirSync, existsSync } = await import('node:fs')
    if (!existsSync(cwd)) {
      try { mkdirSync(cwd, { recursive: true }) } catch { /* tolerate */ }
    }
    // For push operations we want git to inherit a configured
    // credential helper from the per-user OAuth token store, exactly
    // like the worker pod does. We inject `Authorization` via
    // GIT_ASKPASS-equivalent env vars on a per-call basis.
    const oid = attributionFor(identity).oid
    if (op === 'init') {
      try {
        await ensureCanvasGitRepo(cwd)
        return jsonResponse(200, await canvasGitStatus(cwd))
      } catch (err) {
        return jsonResponse(500, {
          error: `canvas git init failed: ${(err as Error).message}`,
        })
      }
    }
    if (op === 'status' && method === 'GET') {
      return jsonResponse(200, await canvasGitStatus(cwd))
    }
    if (op === 'remote' && method === 'POST') {
      const body = (await safeJson(req)) as
        | { url?: string; branch?: string; push?: boolean }
        | null
      const url = body?.url?.trim() || ''
      if (!url) return jsonResponse(400, { error: 'url is required' })
      // Inject the user's GitHub token so https push to github.com
      // works without an interactive prompt. We embed the token in
      // the URL only for the duration of this push, then immediately
      // rewrite the remote back to the plain URL so the token is
      // never persisted in .git/config.
      let pushUrl = url
      try {
        if (oid) {
          const tok = await loadGitHubUserToken(ctx.store, oid)
          if (tok && /^https:\/\/github\.com\//i.test(url)) {
            pushUrl = injectGitCredentials(url, tok.login, tok.token)
          }
        }
      } catch { /* fall through with plain url */ }
      const result = await attachRemoteAndPush(cwd, pushUrl, {
        branch: body?.branch,
        push: body?.push !== false,
      })
      // Rewrite the remote back to the plain URL (no embedded token).
      try {
        const { runGit } = await import('./canvas/git.js')
        await runGit(cwd, ['remote', 'set-url', 'origin', url])
      } catch { /* tolerate */ }
      if (!result.ok) {
        return jsonResponse(500, {
          error: `push failed: ${result.stderr.slice(0, 800) || result.stdout.slice(0, 800)}`,
          code: 'CANVAS_GIT_PUSH',
        })
      }
      return jsonResponse(200, {
        ok: true,
        ...(await canvasGitStatus(cwd)),
      })
    }
    return jsonResponse(404, { error: 'Not found', code: 'NOT_FOUND' })
  }
  // ─── Canvas session destroy ───
  if (method === 'DELETE' && pathname.startsWith('/v1/canvas/')) {
    const canvasSid = pathname.replace('/v1/canvas/', '')
    if (canvasSid) {
      await destroyCanvasPod(ctx.store, canvasSid)
      return jsonResponse(200, { destroyed: true, session_id: canvasSid })
    }
  }
  // ─── Phase 4: stream control + observability ───
  const obsResp = await tryHandleObservabilityRoute(req, pathname, identity, ctx, isAdmin)
  if (obsResp) return obsResp
  // ─── Home (device dashboard refresh + tap-to-control via Home Assistant) ───
  const homeResp = await tryHandleHomeRoute(method, pathname, req)
  if (homeResp) return homeResp
  // ─── Push registration for the 0rb apps ───
  const pushResp = await tryHandlePushRoute(method, pathname, req, ctx.store)
  if (pushResp) return pushResp
  // ─── OAuth relay (one-tap Google/MS/Spotify via orb2.app, free for all) ───
  const relayResp = await tryHandleOAuthRelayRoute(method, pathname, req, url, ctx.store)
  if (relayResp) return relayResp
  // ─── Discovery (skills/MCPs/agents from configured EMU repos) ───
  const discResp = await tryHandleDiscoveryRoute(req, pathname, identity, isAdmin)
  if (discResp) return discResp
  // ─── File upload (per-session uploads under /v1/files/*) ───
  const filesResp = await tryHandleFilesRoute(
    req, pathname, identity, ctx.store, isAdmin, ctx.audit, attributionFor,
  )
  if (filesResp) return filesResp

  const channelsResp = await tryHandleChannelsRoute(method, pathname)
  if (channelsResp) return channelsResp

  const waResp = await tryHandleWhatsAppRoute(method, pathname)
  if (waResp) return waResp

  const voiceResp = await tryHandleVoiceRoute(method, pathname)
  if (voiceResp) return voiceResp

  const clusterResp = await tryHandleClusterRoute(method, pathname, req)
  if (clusterResp) return clusterResp

  // ─── GitHub App installation-token mint (admin/diagnostic) ───
  // Lets an admin verify the App credential is wired correctly without
  // having to drive a full chat turn through the worker. The body of
  // the response contains the token itself, so admin-only.
  if (method === 'POST' && pathname === '/v1/github/installation-token') {
    const tok = await mintGitHubAppToken().catch(() => null)
    if (!tok) {
      return jsonResponse(503, {
        error: 'GitHub App not configured or token mint failed',
        code: 'GITHUB_APP_UNAVAILABLE',
      })
    }
    ctx.audit({
      oid: attributionFor(identity).oid,
      keyId: attributionFor(identity).keyId,
      event: 'github.app.token_minted',
      data: { expires_at: tok.expiresAt },
    })
    return jsonResponse(200, {
      token: tok.token,
      expires_at: tok.expiresAt,
      username: 'x-access-token',
      host: 'github.com',
    })
  }

  return jsonResponse(404, { error: 'Not Found', code: 'NOT_FOUND' })
}

// ─────────────────────── Service info ───────────────────────
function handleStatus(ctx: RuntimeContext): Response {
  const { pendingCount } = require('./jobs/inprocQueue.js') as { pendingCount: () => number }
  return jsonResponse(200, {
    ok: true,
    uptime_s: Math.floor((Date.now() - SERVER_BOOT_TIME) / 1000),
    last_heartbeat_at: _lastHeartbeatAt,
    active_sessions: metrics.activeStreams(),
    pending_jobs: pendingCount(),
  })
}

function handleInfo(ctx: RuntimeContext): Response {
  const ownerToken = process.env.ORB2_OWNER_TOKEN?.trim()
  return jsonResponse(200, {
    agent_id: ctx.agentId,
    instance_id: getRelayReporter()?.getInstanceId() || null,
    version: process.env.ORB2_API_VERSION || 'dev',
    public_url: process.env.ORB2_PUBLIC_URL || null,
    auth_required: (process.env.ORB2_API_AUTH_REQUIRED ?? '0') === '1',
    single_user: process.env.ORB2_API_AUTH_REQUIRED !== '1',
    owner_token_hint: ownerToken ? ownerToken.slice(-4) : null,
    llm: {
      endpoint: process.env.OPENAI_BASE_URL ?? null,
      deployment: process.env.OPENAI_MODEL ?? null,
      api_version: process.env.AZURE_OPENAI_API_VERSION ?? null,
    },
    worker_mode: process.env.ORB2_WORKER_MODE ?? 'in-process',
    environment: process.env.ORB2_ENVIRONMENT || 'dev',
    secret_source: getVaultClient() ? 'vault' : 'redis',
    relay_url: process.env.ORB2_RELAY_URL || null,
    features: {
      thinking: true,
      activity: true,
      vault: !!getVaultClient(),
      workers: isWorkerModeEnabled(),
      skills: isSkillsEnabled(),
      canvas: process.env.ORB2_CANVAS !== 'false',
      canvas_pod: isCanvasModeEnabled(),
    },
    default_mcp_servers: getDefaultMcpServers().map(s => ({
      name: s.name, url: s.url, transport: s.transport,
    })),
  })
}

/**
 * A2A "agent card" served at `/.well-known/agent.json` per the A2A
 * spec (matching `wellKnownEndpoint: true` in our Agent CR).
 */
function buildAgentCard(ctx: RuntimeContext): Record<string, unknown> {
  const tools = cleanToolDefs().map(t => ({
    name: t.name,
    description: t.description,
  }))
  // Build the agent's base URL for the A2A spec `url` field.
  // ORB2_A2A_BASE_URL overrides for production; defaults to localhost.
  const baseUrl = process.env.ORB2_A2A_BASE_URL
    || `http://${ctx.host === '0.0.0.0' ? 'localhost' : ctx.host}:${ctx.port}`
  const agentUrl = `${baseUrl.replace(/\/+$/, '')}/a2a`

  return {
    name: ctx.agentId,
    url: agentUrl,
    description:
      'ORB2 — general-purpose agentic coding assistant with read/write/edit/grep/run tools.',
    version: process.env.ORB2_API_VERSION || 'dev',
    capabilities: {
      contentTypes: ['application/json', 'text/plain'],
      messaging: ['http', 'json', 'jsonrpc'],
      protocols: ['http', 'https'],
      streaming: true,
      sessions: true,
    },
    skills: [
      {
        id: 'code',
        name: 'Code',
        description: 'Author and modify source files with file-edit tools.',
      },
      {
        id: 'plan',
        name: 'Plan',
        description: 'Decompose a task into actionable steps before coding.',
      },
      {
        id: 'explore',
        name: 'Explore',
        description: 'Search and read across a codebase to understand it.',
      },
      {
        id: 'execute',
        name: 'Execute',
        description: 'Run shell commands and tests to verify behaviour.',
      },
    ],
    tools,
    endpoints: {
      chat: '/v1/chat',
      streamChat: '/v1/chat/stream',
      a2a: '/a2a',
      tools: '/v1/tools',
      models: '/v1/models',
      info: '/v1/info',
      openapi: '/openapi.json',
    },
  }
}

// ─────────────────────── Keys ───────────────────────
async function handleListKeys(
  _identity: CallerIdentity,
  ctx: RuntimeContext,
): Promise<Response> {
  const all = await ctx.store.listAllApiKeys()
  return jsonResponse(200, {
    keys: all
      .map(({ record }) => recordToPublic(record))
      .sort((a, b) => a.created_at.localeCompare(b.created_at)),
  })
}

async function handleCreateKey(
  req: Request,
  identity: CallerIdentity,
  ctx: RuntimeContext,
): Promise<Response> {
  if (identity.type !== 'apikey') {
    return jsonResponse(403, {
      error: 'Service identities cannot mint API keys',
      code: 'KEY_FORBIDDEN',
    })
  }
  const parsed = await parseBody(req, CreateKeyRequest)
  if (parsed instanceof Response) return parsed
  const body = parsed.data

  const requestedOwnerEmail = body.owner_email?.trim()
  if (!isAdmin(identity)) {
    if (requestedOwnerEmail && requestedOwnerEmail !== identity.record.ownerEmail) {
      return jsonResponse(403, {
        error: 'Only admins may mint keys for other owners',
        code: 'OWNER_FORBIDDEN',
      })
    }
    if (body.admin === true) {
      return jsonResponse(403, {
        error: 'Only admins may mint admin keys',
        code: 'ADMIN_FORBIDDEN',
      })
    }
  }

  const minted = mintApiKey()
  const ownerEmail = requestedOwnerEmail || identity.record.ownerEmail
  const ownerOid = `app:${slug(ownerEmail)}`
  const record = {
    id: minted.id,
    ownerOid,
    ownerEmail,
    name: body.name.trim(),
    createdAt: new Date().toISOString(),
    allowedModels: Array.isArray(body.allowed_models) ? body.allowed_models : undefined,
    allowedTools: Array.isArray(body.allowed_tools) ? body.allowed_tools : undefined,
    admin: isAdmin(identity) && body.admin === true ? true : undefined,
  }
  await ctx.store.putApiKey(minted.hash, record)

  ctx.audit({
    oid: identity.record.ownerOid,
    keyId: identity.record.id,
    event: 'key.created',
    data: {
      new_key_id: record.id,
      name: record.name,
      owner_email: ownerEmail,
    },
  })

  return jsonResponse(201, {
    plaintext: minted.plaintext,
    ...recordToPublic(record),
  })
}

async function handleRevokeKey(
  id: string,
  identity: CallerIdentity,
  ctx: RuntimeContext,
): Promise<Response> {
  if (identity.type !== 'apikey') {
    return jsonResponse(403, {
      error: 'Service identities cannot revoke keys',
      code: 'KEY_FORBIDDEN',
    })
  }
  const all = await ctx.store.listAllApiKeys()
  const target = all.find(k => k.record.id === id)
  if (!target) return jsonResponse(404, { error: 'Key not found' })
  if (!isAdmin(identity) && target.record.ownerOid !== identity.record.ownerOid) {
    return jsonResponse(403, {
      error: 'Cannot revoke a key you do not own',
      code: 'KEY_FORBIDDEN',
    })
  }
  // Revoking an admin key requires admin privilege — even when the
  // target shares the caller's ownerOid. A non-admin sibling key
  // must not be able to evict an admin key from its own owner pool.
  if (target.record.admin && !isAdmin(identity)) {
    return jsonResponse(403, {
      error: 'Only admins may revoke admin keys',
      code: 'ADMIN_FORBIDDEN',
    })
  }
  if (target.record.admin) {
    const otherAdmins = all.filter(k => k.record.admin && k.record.id !== id)
    if (otherAdmins.length === 0) {
      return jsonResponse(400, {
        error: 'Cannot revoke the only admin key. Mint another admin first.',
        code: 'LAST_ADMIN',
      })
    }
  }
  await ctx.store.delApiKey(target.hash)
  ctx.audit({
    oid: identity.record.ownerOid,
    keyId: identity.record.id,
    event: 'key.revoked',
    data: { revoked_key_id: id, target_owner: target.record.ownerOid },
  })
  return new Response(null, { status: 204 })
}

function recordToPublic(r: {
  id: string
  ownerEmail: string
  name: string
  createdAt: string
  lastUsedAt?: string
  allowedModels?: string[]
  allowedTools?: string[]
  admin?: boolean
}) {
  return {
    id: r.id,
    name: r.name,
    owner_email: r.ownerEmail,
    created_at: r.createdAt,
    last_used_at: r.lastUsedAt ?? null,
    allowed_models: r.allowedModels ?? null,
    allowed_tools: r.allowedTools ?? null,
    admin: r.admin === true,
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

// ─────────────────────── Models / tools ───────────────────────

type ModelEntry = {
  id: string
  provider: 'foundry_anthropic' | 'foundry_openai' | 'azure_openai' | string
  label: string
  isDefault: boolean
  tier: string
  status: 'available' | 'unavailable' | 'probing'
}

const FOUNDRY_CANDIDATE_MODELS: { id: string; label: string; tier: string; type: 'anthropic' | 'openai' }[] = [
  // Anthropic models
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', tier: 'sonnet', type: 'anthropic' },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', tier: 'sonnet', type: 'anthropic' },
  { id: 'claude-sonnet-4', label: 'Claude Sonnet 4', tier: 'sonnet', type: 'anthropic' },
  { id: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet', tier: 'sonnet', type: 'anthropic' },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', tier: 'opus', type: 'anthropic' },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', tier: 'opus', type: 'anthropic' },
  { id: 'claude-opus-4-5', label: 'Claude Opus 4.5', tier: 'opus', type: 'anthropic' },
  { id: 'claude-opus-4-1', label: 'Claude Opus 4.1', tier: 'opus', type: 'anthropic' },
  { id: 'claude-opus-4', label: 'Claude Opus 4', tier: 'opus', type: 'anthropic' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', tier: 'haiku', type: 'anthropic' },
  { id: 'claude-3-5-haiku', label: 'Claude 3.5 Haiku', tier: 'haiku', type: 'anthropic' },
  // OpenAI models
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', tier: 'codex', type: 'openai' },
  { id: 'gpt-4.1', label: 'GPT-4.1', tier: 'gpt', type: 'openai' },
  { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini', tier: 'gpt', type: 'openai' },
  { id: 'gpt-4.1-nano', label: 'GPT-4.1 Nano', tier: 'gpt', type: 'openai' },
  { id: 'gpt-4o', label: 'GPT-4o', tier: 'gpt', type: 'openai' },
  { id: 'gpt-4o-mini', label: 'GPT-4o Mini', tier: 'gpt', type: 'openai' },
  { id: 'o3', label: 'o3', tier: 'reasoning', type: 'openai' },
  { id: 'o3-mini', label: 'o3 Mini', tier: 'reasoning', type: 'openai' },
  { id: 'o4-mini', label: 'o4 Mini', tier: 'reasoning', type: 'openai' },
]

let _foundryProbeCache: ModelEntry[] | null = null
let _foundryProbePromise: Promise<ModelEntry[]> | null = null

async function probeFoundryModel(
  candidate: (typeof FOUNDRY_CANDIDATE_MODELS)[number],
  baseUrl: string,
  apiKey: string,
): Promise<boolean> {
  try {
    const resourceBase = baseUrl.replace(/\/anthropic\/?$/, '')
    let url: string
    let headers: Record<string, string>
    let body: string

    if (candidate.type === 'anthropic') {
      url = `${resourceBase}/anthropic/v1/messages`
      headers = {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'Authorization': `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
      }
      body = JSON.stringify({
        model: candidate.id,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      })
    } else {
      url = `${resourceBase}/openai/deployments/${candidate.id}/chat/completions?api-version=2024-10-21`
      headers = {
        'Content-Type': 'application/json',
        'api-key': apiKey,
      }
      body = JSON.stringify({
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      })
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    })
    // 200 = works, 400 = deployed but wrong request format (e.g. codex),
    // 429 = rate limited (deployed). 401 = bad key. 404 = not deployed.
    if (res.status === 200 || res.status === 400 || res.status === 429) return true
    if (res.status === 401) {
      console.warn(`[models]   ✗ ${candidate.id}: 401 (invalid API key or endpoint)`)
    } else if (res.status !== 404) {
      console.warn(`[models]   ✗ ${candidate.id}: HTTP ${res.status}`)
    }
    return false
  } catch (err) {
    console.warn(`[models]   ✗ ${candidate.id}: ${(err as Error).message}`)
    return false
  }
}

function resolveFoundryProbeBase(): string {
  // The model probe is endpoint-agnostic — it just needs the resource
  // ROOT to build /anthropic/v1/messages and /openai/deployments/...
  // URLs. Accept either ANTHROPIC_FOUNDRY_BASE_URL (with any /anthropic/
  // suffix stripped) or ANTHROPIC_FOUNDRY_RESOURCE (auto-derive the
  // standard host) so the probe works regardless of which knob the
  // chart used.
  const baseUrl = (process.env.ANTHROPIC_FOUNDRY_BASE_URL || '').trim()
  if (baseUrl) {
    return baseUrl.replace(/\/anthropic\/?.*$/, '').replace(/\/+$/, '')
  }
  const resource = (process.env.ANTHROPIC_FOUNDRY_RESOURCE || '').trim()
  if (resource) {
    return `https://${resource}.services.ai.azure.com`
  }
  return ''
}

async function probeFoundryModels(): Promise<ModelEntry[]> {
  const baseUrl = resolveFoundryProbeBase()
  const apiKey = process.env.ANTHROPIC_FOUNDRY_API_KEY || ''
  const defaultModel = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || ''

  if (!baseUrl || !apiKey) {
    console.warn(`[models] Skipping probe: ${!baseUrl ? 'no ANTHROPIC_FOUNDRY_BASE_URL or _RESOURCE set' : 'ANTHROPIC_FOUNDRY_API_KEY not set'}`)
    return []
  }

  console.log(`[models] Probing ${FOUNDRY_CANDIDATE_MODELS.length} candidate models against ${baseUrl} ...`)
  const results = await Promise.all(
    FOUNDRY_CANDIDATE_MODELS.map(async (c) => {
      const available = await probeFoundryModel(c, baseUrl, apiKey)
      if (available) console.log(`[models]   ✓ ${c.id} (${c.type})`)
      return { candidate: c, available }
    }),
  )

  const models: ModelEntry[] = results
    .filter(r => r.available)
    .map(r => ({
      id: r.candidate.id,
      provider: r.candidate.type === 'anthropic' ? 'foundry_anthropic' : 'foundry_openai',
      label: r.candidate.label,
      tier: r.candidate.tier,
      isDefault: r.candidate.id === defaultModel,
      status: 'available' as const,
    }))

  console.log(`[models] Probe complete: ${models.length} model(s) available`)
  return models
}

async function getFoundryModels(): Promise<ModelEntry[]> {
  if (_foundryProbeCache) return _foundryProbeCache
  if (!_foundryProbePromise) {
    _foundryProbePromise = probeFoundryModels().then(models => {
      _foundryProbeCache = models
      return models
    })
  }
  return _foundryProbePromise
}

// Kick off probe at import time in Foundry mode
const _isFoundryMode = ['1', 'true', 'yes', 'on'].includes(
  (process.env.ORB2_USE_FOUNDRY ?? '').trim().toLowerCase(),
)
if (_isFoundryMode) getFoundryModels()

async function getFallbackChainForModel(primaryModel: string): Promise<string[]> {
  if (!_isFoundryMode) return []
  const models = await getFoundryModels()
  return buildFallbackChain(primaryModel, models)
}

async function handleListModels(identity: CallerIdentity | null): Promise<Response> {
  const defaultModel = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || ''
  const allowed =
    identity?.type === 'apikey' ? identity.record.allowedModels : undefined

  let models: ModelEntry[]

  if (_isFoundryMode) {
    models = await getFoundryModels()
    if (models.length === 0) {
      // Fallback: probe hasn't completed or all failed — show default model
      models = [{
        id: defaultModel || 'claude-sonnet-4-6',
        provider: 'foundry_anthropic',
        label: 'Claude Sonnet 4.6',
        tier: 'sonnet',
        isDefault: true,
        status: 'available',
      }]
    }
  } else {
    const deployment = process.env.OPENAI_MODEL || 'gpt-4o'
    const provider = process.env.LLM_PROVIDER || 'azure_openai'
    models = [{
      id: deployment,
      provider,
      label: deployment,
      tier: 'default',
      isDefault: true,
      status: 'available',
    }]
  }

  const filtered = models.filter(
    m => !allowed || allowed.length === 0 || allowed.includes(m.id),
  )
  return jsonResponse(200, {
    models: filtered,
    default_model: defaultModel || models.find(m => m.isDefault)?.id || models[0]?.id,
  })
}

// ─────────────────────── Health check ───────────────────────

type HealthResult = {
  model: string
  chat: { status: 'pass' | 'fail' | 'skip'; latencyMs?: number; tokens?: number; error?: string }
  tools: { status: 'pass' | 'fail' | 'skip'; latencyMs?: number; toolUsed?: string; error?: string }
}

async function runModelTest(
  modelId: string,
  message: string,
  timeoutMs: number,
): Promise<{ fullText: string; toolCalls: string[]; promptTokens: number; completionTokens: number }> {
  const toolCalls: string[] = []
  const result = await runAgentTurn(
    {
      message,
      model: modelId,
      workingDirectory: '/tmp',
      signal: AbortSignal.timeout(timeoutMs),
      autoApprove: () => true,
    },
    {
      onToolStart: async (ev) => { toolCalls.push(ev.toolName) },
    },
  )
  return {
    fullText: result.fullText,
    toolCalls,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
  }
}

async function handleHealthCheck(_ctx: RuntimeContext): Promise<Response> {
  const models = await getFoundryModels()
  if (models.length === 0) {
    const baseUrl = process.env.ANTHROPIC_FOUNDRY_BASE_URL || ''
    const apiKey = process.env.ANTHROPIC_FOUNDRY_API_KEY || ''
    let reason = 'unknown'
    if (!baseUrl) reason = 'ANTHROPIC_FOUNDRY_BASE_URL not set'
    else if (!apiKey) reason = 'ANTHROPIC_FOUNDRY_API_KEY not set'
    else reason = 'All model probes failed (likely 401 — check API key). Run POST /v1/models/reprobe to retry.'
    return jsonResponse(200, { results: [], reason, checkedAt: new Date().toISOString() })
  }

  const results: HealthResult[] = await Promise.all(
    models.map(async (m): Promise<HealthResult> => {
      const entry: HealthResult = {
        model: m.id,
        chat: { status: 'skip' },
        tools: { status: 'skip' },
      }

      // Chat test
      const chatStart = Date.now()
      try {
        const r = await runModelTest(m.id, 'Reply with exactly: OK', 20_000)
        entry.chat = {
          status: r.promptTokens > 0 ? 'pass' : 'fail',
          latencyMs: Date.now() - chatStart,
          tokens: r.promptTokens + r.completionTokens,
          ...(r.promptTokens === 0 && { error: r.fullText.slice(0, 200) }),
        }
      } catch (err) {
        entry.chat = {
          status: 'fail',
          latencyMs: Date.now() - chatStart,
          error: (err as Error).message?.slice(0, 200) || 'Unknown error',
        }
      }

      // Tool test (only if chat passed)
      if (entry.chat.status === 'pass') {
        const toolStart = Date.now()
        try {
          const r = await runModelTest(
            m.id,
            'Use the Bash tool to run: echo health_check_ok',
            30_000,
          )
          if (r.toolCalls.length > 0) {
            entry.tools = {
              status: 'pass',
              latencyMs: Date.now() - toolStart,
              toolUsed: r.toolCalls[0],
            }
          } else {
            entry.tools = {
              status: 'fail',
              latencyMs: Date.now() - toolStart,
              error: 'No tools invoked. Response: ' + r.fullText.slice(0, 120),
            }
          }
        } catch (err) {
          entry.tools = {
            status: 'fail',
            latencyMs: Date.now() - toolStart,
            error: (err as Error).message?.slice(0, 200) || 'Unknown error',
          }
        }
      }

      return entry
    }),
  )

  return jsonResponse(200, { results, checkedAt: new Date().toISOString() })
}

// Re-probe endpoint (for Settings or manual refresh)
async function handleReprobeModels(): Promise<Response> {
  _foundryProbeCache = null
  _foundryProbePromise = null
  const models = await getFoundryModels()
  return jsonResponse(200, { models, reprobed: true })
}

// ─────────────────────── Settings ───────────────────────

// ─────────────────────── Jobs ───────────────────────

async function handleCreateJob(req: Request, identity: CallerIdentity, ctx: RuntimeContext): Promise<Response> {
  const body = await safeJson(req) as { type?: string; description?: string; params?: Record<string, unknown>; requires_approval?: boolean } | null
  if (!body?.type || !body?.description) {
    return jsonResponse(400, { error: 'type and description are required' })
  }
  const attr = attributionFor(identity)
  const result = await executeSubmitJob(
    { type: body.type, description: body.description, params: body.params || {}, requires_approval: body.requires_approval },
    { sessionId: 'api-direct', ownerId: attr.oid || 'anonymous', store: ctx.store },
  )
  return jsonResponse(201, result)
}

async function handleListJobs(identity: CallerIdentity, ctx: RuntimeContext): Promise<Response> {
  const manager = getJobManager(ctx.store)
  // List all jobs across recent sessions (simple scan via store)
  // For now return jobs for the current caller
  const attr = attributionFor(identity)
  const sessionKeys = await ctx.store.getKv(`jobs:session:${attr.oid || 'api-direct'}`)
  if (!sessionKeys) return jsonResponse(200, { jobs: [] })
  // Fallback: return empty for now (full impl needs session tracking)
  return jsonResponse(200, { jobs: [] })
}

async function handleGetJob(jobId: string, ctx: RuntimeContext): Promise<Response> {
  const manager = getJobManager(ctx.store)
  const job = await manager.get(jobId)
  if (!job) return jsonResponse(404, { error: 'Job not found' })
  return jsonResponse(200, { job })
}

async function handleApproveJob(jobId: string, ctx: RuntimeContext): Promise<Response> {
  const manager = getJobManager(ctx.store)
  const job = await manager.approve(jobId)
  if (!job) return jsonResponse(404, { error: 'Job not found' })

  // Publish resume to Fabric
  const envelope: FabricMessageEnvelope = {
    messageId: randomUUID(),
    messageType: 'task.status.updated',
    correlationId: job.id,
    messageVersion: '1.0',
    messageTimestamp: new Date().toISOString(),
    source: 'orb2-api',
    body: {
      userId: job.ownerId,
      contextId: job.sessionId,
      rootTaskId: job.id,
      message: `Job ${job.id} approved and resumed`,
      messageId: randomUUID(),
      agentResponseId: randomUUID(),
      state: 'working',
      agentId: 'orb2',
      timestamp: new Date().toISOString(),
      metadata: { approved: true },
    },
  }
  await publishToFabric(envelope)

  return jsonResponse(200, { job, message: 'Job approved' })
}

async function handleRejectJob(jobId: string, ctx: RuntimeContext, req?: Request): Promise<Response> {
  const manager = getJobManager(ctx.store)
  const job = await manager.reject(jobId)
  if (!job) return jsonResponse(404, { error: 'Job not found' })
  return jsonResponse(200, { job, message: 'Job rejected' })
}

async function handleCancelJob(jobId: string, ctx: RuntimeContext): Promise<Response> {
  // DELETE /v1/jobs/:id maps to JobsManager.reject which marks the
  // job 'cancelled'. Idempotent: a re-delete on a finished job is
  // 404 if it's been GC'd, otherwise no-op + state echo.
  const manager = getJobManager(ctx.store)
  const job = await manager.reject(jobId, 'cancelled via DELETE /v1/jobs/:id')
  if (!job) return jsonResponse(404, { error: 'Job not found' })
  return jsonResponse(200, { job, message: 'Job cancelled' })
}

function handleIntegrationsStatus(): Response {
  return jsonResponse(200, {
    rabbitmq: {
      connected: isRabbitConnected(),
      url: process.env.RABBITMQ_URL ? '****' : null,
      outputQueue: process.env.RABBITMQ_OUTPUT_QUEUE || 'rakoon.jobs.output',
    },
    sandbox: {
      enabled: isSandboxEnabled(),
    },
  })
}

// ─────────────────────── Vault ───────────────────────

async function handleVaultList(ctx: RuntimeContext): Promise<Response> {
  const vault = getVaultStore(ctx.store)
  const entries = await vault.list()
  return jsonResponse(200, { notes: entries, count: entries.length })
}

async function handleVaultSearch(query: string, tags: string[] | undefined, ctx: RuntimeContext): Promise<Response> {
  if (!query && (!tags || tags.length === 0)) {
    return jsonResponse(400, { error: 'q or tags parameter required' })
  }
  const vault = getVaultStore(ctx.store)
  const results = await vault.search(query, tags)
  return jsonResponse(200, { results })
}

async function handleVaultRead(notePath: string, ctx: RuntimeContext): Promise<Response> {
  const result = await executeVaultRead({ path: notePath }, ctx.store)
  if (!result.found) return jsonResponse(404, { error: `Note not found: ${notePath}` })
  return jsonResponse(200, result.note)
}

async function handleVaultWrite(notePath: string, req: Request, ctx: RuntimeContext): Promise<Response> {
  const body = await safeJson(req) as { content?: string; tags?: string[]; aliases?: string[] } | null
  if (!body?.content) return jsonResponse(400, { error: 'content is required' })
  const result = await executeVaultWrite(
    { path: notePath, content: body.content, tags: body.tags, aliases: body.aliases },
    ctx.store,
  )
  return jsonResponse(result.isNew ? 201 : 200, result)
}

async function handleVaultDelete(notePath: string, ctx: RuntimeContext): Promise<Response> {
  const vault = getVaultStore(ctx.store)
  const deleted = await vault.delete(notePath)
  if (!deleted) return jsonResponse(404, { error: `Note not found: ${notePath}` })
  return jsonResponse(200, { deleted: true, path: notePath })
}

async function handleVaultRebuildIndex(ctx: RuntimeContext): Promise<Response> {
  const vault = getVaultStore(ctx.store)
  const entries = await vault.rebuildIndex()
  return jsonResponse(200, { rebuilt: true, count: entries.length })
}

async function handleVaultConsolidate(req: Request, ctx: RuntimeContext): Promise<Response> {
  const body = (await safeJson(req)) as { force?: boolean; model?: string } | null
  const result = await runConsolidation(ctx.store, {
    force: body?.force ?? false,
    model: body?.model,
  })
  return jsonResponse(result.ran ? 200 : 200, result)
}

async function handleVaultConsolidateStatus(ctx: RuntimeContext): Promise<Response> {
  const check = await shouldConsolidate(ctx.store)
  return jsonResponse(200, check)
}

// ─────────────────────── Settings ───────────────────────

// Console-configurable settings for the single-user compose deployment.
// (Obsolete keys removed: RabbitMQ/Fabric, PersonaPlex, whisper.cpp/Piper,
// MCP_SERVER_TOKEN — none apply to the GPU-service voice stack.)
const SETTINGS_KEYS = [
  // Voice (STT/TTS run as GPU services; see ORB2_STT_URL/ORB2_TTS_URL)
  'ORB2_VOICE_ENABLED', 'ORB2_VOICE_BACKEND', 'ORB2_TTS_VOICE',
  'ORB2_STT_URL', 'ORB2_TTS_URL',
  // Home Assistant — the device backbone (lights/locks/climate/etc.)
  'ORB2_HA_URL', 'ORB2_HA_TOKEN',
  // Home location — used for the concierge's "nearby stores" search
  'ORB2_HOME_LOCATION',
  // Push (FCM) — proactive nudges to the 0rb apps
  'ORB2_FCM_PROJECT_ID', 'ORB2_FCM_SERVICE_ACCOUNT',
  // Access — who may sign in, and how OTP codes are emailed
  'ORB2_AUTH_ALLOWED_EMAILS',
  'ORB2_SMTP_HOST', 'ORB2_SMTP_PORT', 'ORB2_SMTP_USER', 'ORB2_SMTP_PASS', 'ORB2_SMTP_FROM',
  // Telegram channel
  'ORB2_TELEGRAM_BOT_TOKEN', 'ORB2_TELEGRAM_OWNER_ID',
  // WhatsApp channel
  'ORB2_OWNER_PHONE',
  // Models — the active model (applied to process.env so chat + voice use it)
  // and the HuggingFace token for gated downloads. BASE_URL/API_KEY let the
  // user point the brain at a cloud OpenAI-compatible endpoint if they can't
  // run locally (endpoint/key changes apply on the next api restart).
  'OPENAI_MODEL', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'ORB2_HF_TOKEN',
  // Model router — default local; route by intent to OpenRouter when enabled.
  'ORB2_ROUTER_ENABLED', 'ORB2_OPENROUTER_KEY', 'ORB2_ROUTER_STRONG_MODEL',
  // Connected apps (set from Settings → Apps; enable the matching tools live)
  'ORB2_YOUTUBE_API_KEY', 'ORB2_SPOTIFY_CLIENT_ID', 'ORB2_SPOTIFY_CLIENT_SECRET',
  'ORB2_NEWSAPI_KEY', 'ORB2_VERCEL_TOKEN', 'ORB2_VERCEL_TEAM_ID',
  // Cloud Storage (Google Drive + Microsoft OneDrive) — OAuth client creds
  'ORB2_GOOGLE_CLIENT_ID', 'ORB2_GOOGLE_CLIENT_SECRET',
  'ORB2_MS_CLIENT_ID', 'ORB2_MS_CLIENT_SECRET',
  // Apps registry — comma-separated ids of widgets the user turned OFF.
  'ORB2_WIDGETS_DISABLED',
] as const

// Keys returned as plaintext (non-secret config). All others are masked.
const SETTINGS_PLAINTEXT_KEYS = new Set([
  'ORB2_VOICE_ENABLED', 'ORB2_VOICE_BACKEND', 'ORB2_TTS_VOICE',
  'ORB2_STT_URL', 'ORB2_TTS_URL',
  'ORB2_AUTH_ALLOWED_EMAILS',
  'ORB2_SMTP_HOST', 'ORB2_SMTP_PORT', 'ORB2_SMTP_FROM',
  'ORB2_TELEGRAM_OWNER_ID', 'ORB2_OWNER_PHONE', 'OPENAI_MODEL', 'OPENAI_BASE_URL',
  'ORB2_WIDGETS_DISABLED', 'ORB2_ROUTER_ENABLED', 'ORB2_ROUTER_STRONG_MODEL',
])

// Keys that trigger channel hot-reload when updated (no restart needed).
const CHANNEL_SETTINGS_KEYS = new Set([
  'ORB2_VOICE_ENABLED', 'ORB2_VOICE_BACKEND', 'ORB2_TTS_VOICE',
  'ORB2_STT_URL', 'ORB2_TTS_URL',
  'ORB2_TELEGRAM_BOT_TOKEN', 'ORB2_TELEGRAM_OWNER_ID', 'ORB2_OWNER_PHONE',
])

const SETTINGS_KV_PREFIX = 'setting:'

async function handleGetSettings(ctx: RuntimeContext): Promise<Response> {
  const { getAllSkills } = await import('./skills/registry.js')
  const skills = getAllSkills().map(s => ({
    name: s.name,
    description: s.description,
    mcpServers: s.mcpServers.map(m => ({
      name: m.name,
      url: m.url,
      transport: m.transport,
    })),
  }))

  const vaultClient = getVaultClient()
  const settings: Record<string, string> = {}
  for (const key of SETTINGS_KEYS) {
    const envVal = process.env[key] ?? ''
    const redisVal = await ctx.store.getKv(`${SETTINGS_KV_PREFIX}${key}`) ?? ''
    const val = envVal || redisVal
    // Return plaintext for non-secret config keys so UI can pre-fill forms
    settings[key] = val
      ? (SETTINGS_PLAINTEXT_KEYS.has(key) ? val : '••••••••')
      : ''
  }

  return jsonResponse(200, {
    settings,
    skills,
    secret_source: vaultClient ? 'vault' : 'redis',
    vault_configured: !!vaultClient,
  })
}

async function handlePutSettings(
  req: Request,
  identity: CallerIdentity,
  ctx: RuntimeContext,
): Promise<Response> {
  let body: Record<string, any>
  try {
    body = await req.json()
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON' })
  }

  const updated: string[] = []
  const vaultClient = getVaultClient()
  const attribution = attributionFor(identity)
  for (const key of SETTINGS_KEYS) {
    if (typeof body[key] === 'string' && body[key].trim()) {
      const value = body[key].trim()
      // Write to vault if configured, always write to redis as fallback
      let vaultOk = false
      if (vaultClient) {
        try { await putSecretToVault(key, value); vaultOk = true } catch { /* fallback to redis */ }
      }
      await ctx.store.putKv(`${SETTINGS_KV_PREFIX}${key}`, value, 0)
      process.env[key] = value
      updated.push(key)
      // Audit each secret write -- key only, never the value.
      ctx.audit({
        ...attribution,
        event: 'settings.put',
        data: { key, vault: vaultOk, fallback: !vaultOk && !!vaultClient },
      })
    }
  }

  if (updated.length === 0) {
    return jsonResponse(400, { error: 'No valid settings provided', valid_keys: [...SETTINGS_KEYS] })
  }

  // Reconnect RabbitMQ if URL was updated
  if (updated.includes('RABBITMQ_URL')) {
    connectRabbit().catch(() => {})
  }

  // Invalidate skill cache so MCP_SERVER_TOKEN changes take effect immediately
  if (updated.includes('MCP_SERVER_TOKEN')) {
    const { invalidateSkillCache } = await import('./skills/registry.js')
    invalidateSkillCache()
  }

  // Hot-reload channels if any channel config key changed
  if (updated.some(k => CHANNEL_SETTINGS_KEYS.has(k))) {
    const { restartChannels } = await import('./channels/registry.js')
    void restartChannels(ctx.store)
  }

  return jsonResponse(200, { updated, message: `Updated ${updated.length} setting(s). Changes take effect immediately.` })
}

async function handleDeleteSetting(
  settingKey: string,
  identity: CallerIdentity,
  ctx: RuntimeContext,
): Promise<Response> {
  const key = settingKey.toUpperCase()
  if (!SETTINGS_KEYS.includes(key as any)) {
    return jsonResponse(400, { error: `Unknown setting: ${settingKey}`, valid_keys: [...SETTINGS_KEYS] })
  }
  const vaultClient = getVaultClient()
  let vaultOk = false
  if (vaultClient) {
    try { await deleteSecretFromVault(key); vaultOk = true } catch { /* best effort */ }
  }
  await ctx.store.delKv(`${SETTINGS_KV_PREFIX}${key}`)
  delete process.env[key]

  ctx.audit({
    ...attributionFor(identity),
    event: 'settings.delete',
    data: { key, vault: vaultOk },
  })

  if (key === 'MCP_SERVER_TOKEN') {
    const { invalidateSkillCache } = await import('./skills/registry.js')
    invalidateSkillCache()
  }

  return jsonResponse(200, { deleted: key, message: `Setting ${key} removed.` })
}

// ─────────────────────── Skill CRUD ───────────────────────

function handleGetSkill(name: string): Response {
  const { getAllSkills, getSkillsDir } = require('./skills/registry.js')
  const skills = getAllSkills()
  const skill = skills.find((s: any) => s.name === name)
  if (!skill) return jsonResponse(404, { error: `Skill not found: ${name}` })

  const raw = readSkillRaw(getSkillsDir(), name)
  return jsonResponse(200, {
    name: skill.name,
    description: skill.description,
    keywords: skill.keywords || '',
    enabled: !isSkillDisabled(skill.name),
    instructions: skill.instructions,
    mcp_servers: skill.mcpServers.map((m: any) => ({
      name: m.name,
      url: m.url,
      transport: m.transport,
      headers: m.headers,
    })),
    raw_markdown: raw,
  })
}

async function handleCreateSkill(req: Request, ctx: RuntimeContext): Promise<Response> {
  let body: any
  try { body = await req.json() } catch { return jsonResponse(400, { error: 'Invalid JSON' }) }

  const { name, description, instructions, mcpServers, keywords } = body
  if (!name || !description || !instructions) {
    return jsonResponse(400, { error: 'name, description, and instructions are required' })
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    return jsonResponse(400, { error: 'name must be kebab-case (lowercase letters, numbers, hyphens)' })
  }

  const { getSkillsDir, getAllSkills, invalidateSkillCache } = await import('./skills/registry.js')
  const existing = getAllSkills().find(s => s.name === name)
  if (existing) {
    return jsonResponse(409, { error: `Skill already exists: ${name}. Use PUT /v1/skills/${name} to update.` })
  }

  const content = serializeSkill({ name, description, instructions, mcpServers, keywords })
  writeSkillFile(getSkillsDir(), name, content)
  invalidateSkillCache()

  return jsonResponse(201, { created: name, message: `Skill ${name} created and available immediately.` })
}

async function handleUpdateSkill(name: string, req: Request, ctx: RuntimeContext): Promise<Response> {
  let body: any
  try { body = await req.json() } catch { return jsonResponse(400, { error: 'Invalid JSON' }) }

  const { getSkillsDir, invalidateSkillCache } = await import('./skills/registry.js')
  const raw = readSkillRaw(getSkillsDir(), name)
  if (!raw) return jsonResponse(404, { error: `Skill not found: ${name}` })

  const description = body.description
  const instructions = body.instructions
  const mcpServers = body.mcpServers
  const keywords = body.keywords

  if (!description || !instructions) {
    return jsonResponse(400, { error: 'description and instructions are required' })
  }

  const content = serializeSkill({ name, description, instructions, mcpServers, keywords })
  writeSkillFile(getSkillsDir(), name, content)
  invalidateSkillCache()

  return jsonResponse(200, { updated: name, message: `Skill ${name} updated.` })
}

function handleDeleteSkill(name: string, ctx: RuntimeContext): Response {
  const { getSkillsDir, invalidateSkillCache } = require('./skills/registry.js')
  const raw = readSkillRaw(getSkillsDir(), name)
  if (!raw) return jsonResponse(404, { error: `Skill not found: ${name}` })

  deleteSkillFile(getSkillsDir(), name)
  invalidateSkillCache()

  return jsonResponse(200, { deleted: name, message: `Skill ${name} deleted.` })
}

async function handleToggleSkill(name: string, action: 'enable' | 'disable', ctx: RuntimeContext): Promise<Response> {
  const { getAllSkills } = await import('./skills/registry.js')
  const skill = getAllSkills().find(s => s.name === name)
  if (!skill) return jsonResponse(404, { error: `Skill not found: ${name}` })

  const disabled = action === 'disable'
  setSkillDisabled(name, disabled)
  await ctx.store.putKv(disabledSkillKey(name), disabled ? '1' : '0', 0)

  return jsonResponse(200, {
    skill: name,
    enabled: !disabled,
    message: `Skill ${name} ${disabled ? 'disabled' : 'enabled'}.`,
  })
}

/**
 * Heuristic: which tools NEED filesystem/shell access (must run in a
 * worker pod with the workspace mounted) vs which are pure HTTP/state
 * ops (can run in the router for low latency). Used by the
 * `/v1/tools/:name/invoke` route to choose dispatch=worker by default
 * for mutating tools.
 */
const POD_ONLY_TOOLS = new Set([
  'Bash', 'PowerShell', 'Read', 'FileRead',
  'Write', 'FileWrite', 'Edit', 'FileEdit', 'MultiEdit',
  'Glob', 'Grep', 'NotebookEdit', 'EnterWorktree', 'ExitWorktree',
])

function handleListTools(identity: CallerIdentity | null): Response {
  const allowed =
    identity?.type === 'apikey' ? identity.record.allowedTools : undefined
  const tools = cleanToolDefs()
    .filter(t => !allowed || allowed.length === 0 || allowed.includes(t.name))
    .map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema ?? null,
      runs_on: POD_ONLY_TOOLS.has(t.name) ? 'pod' : 'either',
    }))
  // API-native tools (cluster/docker/self-update/jobs/sandbox/vault).
  // `available` reflects whether the capability is wired in this env.
  const nativeTools = apiNativeToolDefs()
    .filter(d => !allowed || allowed.length === 0 || allowed.includes(d.name))
    .map(d => ({
      name: d.name,
      description: d.description,
      input_schema: d.input_schema,
      runs_on: 'router' as const,
      available: d.available,
    }))
  return jsonResponse(200, { tools: [...tools, ...nativeTools] })
}

// ─────────────────────── Verb mapping ───────────────────────
const TOOL_VERBS: Record<string, string> = {
  Read: 'Reading',
  Edit: 'Editing',
  MultiEdit: 'Editing',
  Write: 'Creating',
  Create: 'Creating',
  Bash: 'Running',
  Grep: 'Searching',
  Glob: 'Scanning',
  LS: 'Listing',
  WebFetch: 'Fetching',
  WebSearch: 'Searching web',
  TodoWrite: 'Planning',
  Skill: 'Using skill',
  Canvas: 'Canvas',
  Agent: 'Delegating',
  Task: 'Delegating',
}

function toolVerb(toolName: string): string {
  if (TOOL_VERBS[toolName]) return TOOL_VERBS[toolName]
  if (toolName.startsWith('mcp__') || toolName.startsWith('mcp_')) return 'Calling'
  return 'Using'
}

function toolTarget(toolName: string, args: unknown): string {
  const a = args as Record<string, unknown> | null
  if (!a) return ''
  if (typeof a.file_path === 'string') return path.basename(a.file_path)
  if (typeof a.command === 'string') return (a.command as string).slice(0, 40)
  if (typeof a.pattern === 'string') return `'${(a.pattern as string).slice(0, 30)}'`
  if (typeof a.query === 'string') return `'${(a.query as string).slice(0, 30)}'`
  if (typeof a.url === 'string') return (a.url as string).slice(0, 50)
  if (typeof a.skill === 'string') return a.skill as string
  if (typeof a.action === 'string' && toolName === 'Canvas') {
    const action = a.action as string
    if (action === 'init' && typeof a.template === 'string') return `init ${a.template}`
    if (action === 'open' && typeof a.entry === 'string') return `open ${a.entry}`
    if (action === 'write_files' && Array.isArray(a.files)) return `+${(a.files as unknown[]).length} files`
    return action
  }
  return ''
}

function summarizeThinking(text: string, maxLen = 120): string {
  const firstLine = text.split('\n').find(l => l.trim().length > 0) || ''
  return firstLine.length > maxLen ? firstLine.slice(0, maxLen) + '...' : firstLine
}

// ─────────────────────── Sub-worker dispatch ───────────────────────
async function handleSpawnWorker(
  req: Request,
  identity: CallerIdentity,
  ctx: RuntimeContext,
): Promise<Response> {
  if (!isWorkerModeEnabled()) {
    return jsonResponse(503, {
      error: 'worker mode not enabled (ORB2_WORKER_MODE=k8s-jobs)',
      code: 'WORKERS_DISABLED',
    })
  }
  const body = (await safeJson(req)) as
    | {
        message?: string
        model?: string
        previous_messages?: unknown[]
        working_directory?: string
        knobs?: Record<string, unknown>
        session_id?: string
        turn_id?: string
      }
    | null
  if (!body || typeof body.message !== 'string' || !body.message.trim()) {
    return jsonResponse(400, { error: 'message is required' })
  }
  const sessionId = body.session_id?.trim() || randomUUID()
  const turnId = body.turn_id?.trim() || randomUUID()
  try {
    const palettes = await buildWorkerPalettes(ctx.store)
    const gitCredentials = await buildGitCredentials(ctx.store, attributionFor(identity).oid)
    const r = await launchWorkerJob(ctx.store, turnId, {
      taskId: turnId,
      sessionId,
      message: body.message,
      model: body.model,
      previousMessages: Array.isArray(body.previous_messages) ? body.previous_messages : [],
      workingDirectory: body.working_directory,
      knobs: body.knobs as any,
      ...palettes,
      ...(gitCredentials && { gitCredentials }),
    })
    return jsonResponse(200, {
      turn_id: turnId,
      session_id: sessionId,
      job_name: r.jobName,
      reused: r.reused === true,
    })
  } catch (err) {
    return jsonResponse(500, {
      error: 'sub-worker spawn failed',
      message: (err as Error).message,
    })
  }
}

// ─────────────────────── Slash-command dispatch ───────────────────────
async function handleCommand(
  commandName: string,
  req: Request,
  identity: CallerIdentity,
  ctx: RuntimeContext,
): Promise<Response> {
  const command = getCommand(commandName)
  if (!command) {
    return jsonResponse(404, {
      error: `Command ${commandName} is not registered`,
      code: 'COMMAND_NOT_FOUND',
    })
  }
  const body = (await safeJson(req)) as
    | {
        args?: Record<string, unknown>
        session_id?: string
        working_directory?: string
        model?: string
        stream?: boolean
      }
    | null
  const args = body?.args ?? {}
  // Check required args
  for (const r of command.args_schema.required ?? []) {
    if (!(r in args)) {
      return jsonResponse(400, {
        error: `missing required arg: ${r}`,
        code: 'COMMAND_ARG_MISSING',
      })
    }
  }
  const rendered = command.template(args)
  // Re-route to /v1/chat by forging a Request-like object. Cleanest
  // is to call handleChat with a synthetic Request wrapping the body
  // it expects.
  const chatBody = {
    message: rendered.message,
    session_id: body?.session_id,
    working_directory: body?.working_directory,
    model: body?.model,
    allowed_tools_override: rendered.suggestedTools,
  }
  const chatReq = new Request(req.url.replace(/\/v1\/commands\/.*/, '/v1/chat'), {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(chatBody),
  })
  return handleChat(chatReq, identity, ctx, body?.stream === true)
}

// ─────────────────────── Sub-agent registry ───────────────────────
async function handleListAgents(ctx: RuntimeContext): Promise<Response> {
  // Best-effort: every model from /v1/models doubles as a usable
  // "agent". We also surface the bundled sub-agents that the agent
  // tool palette references (Agent, Skill, Task) as logical agents
  // routable via the `agent_id` knob in /v1/chat.
  const logicalAgents = [
    {
      id: 'default',
      name: 'ORB2 default agent',
      description: 'Standard ORB2 agent loop with full tool palette.',
    },
    {
      id: 'skill-runner',
      name: 'Skill runner',
      description: 'Resolves the best matching skill for the message and runs that workflow.',
    },
    {
      id: 'commit-bot',
      name: 'Commit bot',
      description: 'Templated /commit command runner.',
    },
    {
      id: 'reviewer',
      name: 'Reviewer',
      description: 'Templated /review command runner.',
    },
    {
      id: 'security-reviewer',
      name: 'Security reviewer',
      description: 'Templated /security-review command runner (long-running).',
    },
  ]
  // Augment with discovered agents from EMU repos. They yield to
  // built-ins on id collision (we just append; consumer sees both).
  const discovered = getDiscoveredAgents().map(a => ({
    id: a.id,
    name: a.name,
    description: a.description,
    source_repo: a.source_repo,
    trust: a.trust,
    tools: a.tools,
    model: a.model,
  }))
  // Dynamic agents registered via POST /v1/agents.
  let dynamic: any[] = []
  try {
    const list = await listDynamicAgents(ctx.store)
    dynamic = list.map(a => ({
      id: a.id,
      name: a.name,
      description: a.description,
      tools: a.tools,
      model: a.model,
      trust: 'dynamic' as const,
      persisted: a.persisted,
      created_at: a.created_at,
      created_by: a.created_by,
    }))
  } catch { /* dynamic registry optional */ }
  return jsonResponse(200, { agents: [...logicalAgents, ...discovered, ...dynamic] })
}

async function handleCreateAgent(
  req: Request,
  identity: CallerIdentity,
  ctx: RuntimeContext,
): Promise<Response> {
  let body: any
  try { body = await req.json() } catch {
    return jsonResponse(400, { error: 'Invalid JSON' })
  }
  if (!body || typeof body !== 'object') {
    return jsonResponse(400, { error: 'Body must be an object' })
  }
  try {
    const created = await createDynamicAgent(ctx.store, {
      id: typeof body.id === 'string' ? body.id : undefined,
      name: String(body.name ?? ''),
      description: String(body.description ?? ''),
      prompt: String(body.prompt ?? ''),
      tools: Array.isArray(body.tools)
        ? body.tools.filter((t: unknown): t is string => typeof t === 'string')
        : undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
      persist: !!body.persist,
    }, identity.type === 'apikey' ? identity.record.id : identity.type === 'service' ? identity.agentId : identity.username)
    ctx.audit({
      ...attributionFor(identity),
      event: 'agent.create',
      data: { id: created.id, persisted: created.persisted, tools: created.tools?.length ?? 0 },
    })
    return jsonResponse(201, { agent: created })
  } catch (err) {
    return jsonResponse(400, { error: (err as Error).message })
  }
}

async function handleDeleteAgent(
  id: string,
  identity: CallerIdentity,
  ctx: RuntimeContext,
): Promise<Response> {
  const ok = await deleteDynamicAgent(ctx.store, id)
  ctx.audit({
    ...attributionFor(identity),
    event: 'agent.delete',
    data: { id, found: ok },
  })
  if (!ok) return jsonResponse(404, { error: `Agent ${id} not found` })
  return jsonResponse(200, { deleted: id })
}

// ─────────────────────── Direct tool invoke ───────────────────────
async function handleToolInvoke(
  toolName: string,
  req: Request,
  identity: CallerIdentity,
  ctx: RuntimeContext,
): Promise<Response> {
  const parsedTool = await parseBody(req, ToolInvokeRequest)
  if (parsedTool instanceof Response) return parsedTool
  const body = parsedTool.data
  // Permission check: caller must have the tool in their allowlist
  // (or have no per-key allowlist at all). Service identities can
  // invoke any tool, matching the chat-handler behavior.
  if (
    identity.type === 'apikey' &&
    identity.record.allowedTools?.length &&
    !identity.record.allowedTools.includes(toolName)
  ) {
    return jsonResponse(403, {
      error: `Tool ${toolName} is not allowed for this API key`,
      code: 'TOOL_FORBIDDEN',
    })
  }
  // Verify the tool exists and is enabled in this build (core tools or
  // API-native tools).
  const known = cleanToolDefs().find(t => t.name === toolName)
  const nativeDef = apiNativeToolDefs().find(d => d.name === toolName)
  if (!known && !nativeDef) {
    return jsonResponse(404, {
      error: `Tool ${toolName} is not registered`,
      code: 'TOOL_NOT_FOUND',
    })
  }
  if (nativeDef && !nativeDef.available) {
    return jsonResponse(503, {
      error: `Tool ${toolName} is not available in this environment`,
      code: 'TOOL_UNAVAILABLE',
    })
  }

  const sessionId = body.session_id?.trim() || randomUUID()
  const workspaceRoot = process.env.ORB2_API_WORKSPACE_ROOT || '/workspace'
  let workingDirectory: string
  try {
    workingDirectory = safeJoinUnderWorkspace(workspaceRoot, body.working_directory, sessionId)
  } catch (err) {
    if (isWorkspaceEscape(err)) {
      return jsonResponse(400, {
        error: err.message,
        code: err.code,
      })
    }
    throw err
  }
  ensureDir(workingDirectory)

  const message =
    `Call the ${toolName} tool exactly once with these arguments and ` +
    `then reply with only "[OK]" and nothing else. Arguments:\n` +
    `\`\`\`json\n${JSON.stringify(body.arguments, null, 2)}\n\`\`\``

  let toolOutput: string | null = null
  let toolError = false
  let toolUseId: string | null = null

  const invokeNativeTools = buildApiNativeTools({
    store: ctx.store,
    sessionId,
    ownerId: attributionFor(identity).oid || 'owner',
  })

  try {
    await runAgentTurn(
      {
        message,
        model: body.model,
        workingDirectory,
        previousMessages: [],
        autoApprove: () => true,
        sessionId,
        allowedTools: new Set([toolName]),
        extraTools: invokeNativeTools,
      },
      {
        onToolStart: e => {
          toolUseId = e.toolUseId
        },
        onToolResult: e => {
          if (toolOutput === null) {
            toolOutput = e.output
            toolError = e.isError
          }
        },
        onLog: (l, m, d) => log[l]?.(m, d as any),
      },
    )
  } catch (err) {
    return jsonResponse(500, {
      error: 'tool invocation failed',
      message: (err as Error).message,
    })
  }

  if (toolOutput === null) {
    return jsonResponse(500, {
      error: 'tool did not produce a result',
      code: 'NO_TOOL_RESULT',
    })
  }
  return jsonResponse(200, {
    tool_name: toolName,
    tool_use_id: toolUseId,
    output: toolOutput,
    is_error: toolError,
    session_id: sessionId,
  })
}

// ─────────────────────── Chat ───────────────────────
async function handleChat(
  req: Request,
  identity: CallerIdentity,
  ctx: RuntimeContext,
  streaming: boolean,
): Promise<Response> {
  if (
    ctx.maxConcurrentStreams > 0 &&
    metrics.activeStreams() >= ctx.maxConcurrentStreams
  ) {
    return jsonResponse(503, {
      error: 'Server at capacity',
      code: 'RESOURCE_EXHAUSTED',
    })
  }

  const body = (await safeJson(req)) as
    | {
        message?: string
        session_id?: string
        model?: string
        working_directory?: string
        task_packet_json?: string
        include_thinking?: boolean
        include_activity?: boolean
        // Phase 1 per-request knobs (all optional; absent = current behavior)
        output_style?: string
        thinking_budget?: number
        plan_mode?: boolean
        deny_tools?: string[]
        allowed_tools_override?: string[]
        turn_id?: string
        agent_id?: string
        worktree?: { branch?: string; root?: string }
        session_settings?: Record<string, unknown>
        /**
         * IDs returned from POST /v1/files. The matching files for
         * this session are surfaced to the agent as a system note
         * naming their absolute paths so it can read them with the Read tool. Files not owned by the caller are silently skipped.
         */
        attached_file_ids?: string[]
        /** Enable canvas mode — routes to a long-lived pod with Vite preview. */
        canvas?: boolean | { template?: CanvasTemplate }
      }
    | null
  if (!body || typeof body.message !== 'string' || body.message.length === 0) {
    return jsonResponse(400, { error: 'message is required' })
  }

  // Per-request allowed_tools_override narrows but never widens the
  // apikey allowlist. The intersection is what the agent sees.
  let allowedTools =
    identity.type === 'apikey' && identity.record.allowedTools?.length
      ? new Set(identity.record.allowedTools)
      : undefined
  if (Array.isArray(body.allowed_tools_override) && body.allowed_tools_override.length > 0) {
    const requested = new Set(body.allowed_tools_override)
    allowedTools = allowedTools
      ? new Set([...allowedTools].filter(t => requested.has(t)))
      : requested
  }
  let denyTools = Array.isArray(body.deny_tools)
    ? body.deny_tools.filter((t: unknown) => typeof t === 'string') as string[]
    : undefined
  // Phase 6: when the skills feature is OFF the model must not see
  // SkillTool in its schema. We add it to denyTools (rather than
  // failing the request) so a single deployment can flip the toggle
  // on/off at runtime without restarting any router pod. Combined
  // with the empty getEnabledSkills() result and the skill-section
  // gating in constants/prompts.ts, the agent then has zero textual
  // mention of skills -- no /skill commands listed, no
  // skill_discovery attachment, no DiscoverSkills tool guidance --
  // so it cannot reference a missing skill in its replies.
  if (!isSkillsEnabled()) {
    denyTools = [...new Set([...(denyTools ?? []), 'Skill', 'DiscoverSkills'])]
  }
  const allowedModels =
    identity.type === 'apikey' && identity.record.allowedModels?.length
      ? new Set(identity.record.allowedModels)
      : undefined
  if (body.model && allowedModels && !allowedModels.has(body.model)) {
    return jsonResponse(403, {
      error: `Model ${body.model} is not allowed for this API key`,
    })
  }

  // Extract user bearer token for MCP authentication.
  // Resolution order: (1) Authorization header from Fabric Next,
  // (2) console-set MCP_SERVER_TOKEN from PUT /v1/settings (testing only)
  const authHeader = req.headers.get('Authorization')
  const mcpToken = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7).trim() || undefined
    : undefined

  const sessionId = body.session_id?.trim() || randomUUID()
  // API-native tools (ClusterOps, DockerOps, SelfUpdate, SubmitJob,
  // RunCode, Vault*) bound to this request's state and appended to the
  // agent's tool set. Subject to the same allowedTools/denyTools gating.
  const apiNativeTools = buildApiNativeTools({
    store: ctx.store,
    sessionId,
    ownerId: attributionFor(identity).oid || 'owner',
  })
  // Honour any pre-set abort flag so a DELETE /v1/chat/stream/:turnId
  // that races ahead of the chat request is respected.
  if (body.turn_id && (await isTurnAborted(ctx.store, body.turn_id))) {
    return jsonResponse(409, {
      error: 'turn was aborted before it could start',
      code: 'TURN_ABORTED',
      turn_id: body.turn_id,
    })
  }
  const workspaceRoot = process.env.ORB2_API_WORKSPACE_ROOT || '/workspace'
  let workingDirectory: string
  try {
    workingDirectory = safeJoinUnderWorkspace(workspaceRoot, body.working_directory, sessionId)
  } catch (err) {
    if (isWorkspaceEscape(err)) {
      return jsonResponse(400, { error: err.message, code: err.code })
    }
    throw err
  }
  ensureDir(workingDirectory)

  let previousMessages = (await ctx.store.getSession(sessionId)) ?? []
  const attribution = attributionFor(identity)

  // Sticky model: if a previous turn fell back to a working model, prefer
  // that on subsequent turns instead of re-trying the failed primary on
  // every request. The client can override by sending an explicit
  // body.model (e.g. user picked a new model in the dropdown).
  const previousMeta = await ctx.store.getSessionMeta(sessionId)
  const stickyModel = previousMeta?.model && previousMeta.model.trim()
    ? previousMeta.model.trim()
    : ''
  const requestedModel = body.model?.trim() || ''
  const resolvedModel =
    requestedModel ||
    stickyModel ||
    process.env.ORB2_DEFAULT_MODEL ||
    'claude-sonnet-4-5'

  // Cross-user isolation: if the client supplied a session_id that
  // already exists, refuse to attach unless the requesting identity
  // owns it. This prevents user B from streaming the events of an
  // active session belonging to user A by guessing or replaying the
  // session_id. Only enforced when the caller authenticated with an
  // API key; service identities (Fabric internal) keep the open
  // behavior so internal traffic isn't blocked.
  if (
    body.session_id?.trim() &&
    identity.type === 'apikey' &&
    previousMessages.length > 0
  ) {
    const meta = await ctx.store.getSessionMeta(sessionId)
    const ownerOid = meta?.ownerOid
    if (ownerOid && attribution.oid && ownerOid !== attribution.oid) {
      const errBody = JSON.stringify({
        error: 'session belongs to a different user',
        code: 'SESSION_FORBIDDEN',
      })
      return new Response(errBody, {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })
    }
  }

  // Compact session if context window is filling up
  try {
    const { messages: compactedMessages, result: compactResult } =
      await maybeCompactSession(sessionId, previousMessages, ctx.store, body.model)
    if (compactResult.compacted) {
      previousMessages = compactedMessages
      ctx.audit({
        ...attribution,
        event: 'chat.compacted',
        data: {
          session_id: sessionId,
          original_tokens: compactResult.originalTokens,
          compacted_tokens: compactResult.compactedTokens,
          messages_removed: compactResult.messagesRemoved,
        },
      })
    }
  } catch { /* compaction failure should not block chat */ }

  // Inject pending job status so the agent is aware of async tasks.
  // The injected `[Job <id>] COMPLETED -- update your todo list` line
  // is the only thing that ties async work back to the user-visible
  // todo list -- the agent then calls TodoWrite to mark the matching
  // item completed on its own.
  const jobManager = getJobManager(ctx.store)
  const pendingJobs = await jobManager.listPendingForSession(sessionId)
  const recentlyDone = await jobManager.listRecentlyCompletedForSession(sessionId)
  let chatMessage = body.message
  if (pendingJobs.length > 0 || recentlyDone.length > 0) {
    const lines: string[] = []
    for (const j of pendingJobs) {
      lines.push(`[Job ${j.id}] ${j.type}: ${j.status}${j.pendingApproval ? ` -- "${j.pendingApproval.message}"` : ''}`)
    }
    for (const j of recentlyDone) {
      lines.push(`[Job ${j.id}] ${j.type}: ${j.status.toUpperCase()} -- update your todo list (call TodoWrite to mark the matching item completed)`)
    }
    chatMessage = `[SYSTEM: Async job updates]\n${lines.join('\n')}\n\n[USER MESSAGE]\n${body.message}`
  }

  // Advisory intent hint -- prepended to the message so the agent can
  // choose to delegate long-running asks via SubmitJob. Heuristic-only
  // and conservative; null = do not modify the message at all.
  try {
    const hint = classifyIntent(body.message)
    if (hint) {
      chatMessage = `${renderHint(hint)}\n\n${chatMessage}`
      log.info('intent_hint_attached', { sessionId, triggers: hint.triggers })
    }
  } catch { /* hinting must never block a chat */ }

  // Canvas is now an explicit Tool (see src/tools/CanvasTool/) — the model
  // decides when to invoke it. No always-on system prompt injection.

  // Inject relevant vault knowledge for cross-session memory
  try {
    const vault = getVaultStore(ctx.store)
    const vaultResults = await vault.search(body.message, undefined, 3)
    if (vaultResults.length > 0) {
      const vaultContext = vaultResults.map(r =>
        `- [[${r.title}]] (${r.tags.join(', ')}): ${r.snippet}`
      ).join('\n')
      chatMessage = `[SYSTEM: Relevant knowledge from vault]\n${vaultContext}\n\n${chatMessage}`
    }
  } catch { /* vault search failure should not block chat */ }

  // Resolve attached files into a system note so the agent sees the
  // absolute paths and can read them with the Read tool. Files not owned
  // by the caller are silently dropped.
  if (Array.isArray(body.attached_file_ids) && body.attached_file_ids.length > 0) {
    const ownerOid = identity.type === 'apikey' ? identity.record.ownerOid : undefined
    const lines: string[] = []
    for (const fid of body.attached_file_ids) {
      if (typeof fid !== 'string') continue
      const meta = await filesGetMeta(ctx.store, fid)
      if (!meta) continue
      if (meta.session_id !== sessionId) continue
      if (meta.owner_oid && ownerOid && meta.owner_oid !== ownerOid && !isAdmin(identity)) continue
      lines.push(
        `- ${meta.name} (${meta.size} bytes, ${meta.content_type}) -> ${meta.path}`,
      )
    }
    if (lines.length > 0) {
      chatMessage =
        `[SYSTEM: The user attached the following files. Read them with the file-read tool against the absolute path on the right.\n` +
        ` Binary formats (xlsx, pdf, png, ...) must be parsed before use; do NOT pass raw bytes into Canvas write_files, only the derived\n` +
        ` HTML / JSON / SVG that summarizes them.]\n` +
        `${lines.join('\n')}\n\n` +
        `${chatMessage}`
    }
  }

  // ─── Topic-policy pre-flight gate (does NOT touch the agent loop) ──
  // Evaluate the configured topic policy against the original user
  // message; if a rider is produced, prepend it to chatMessage so the
  // same instruction propagates through canvas-pod and worker-pod
  // dispatch alike without any change inside agentRunner.ts.
  try {
    const topicPolicy = await loadTopicPolicy(ctx.store)
    if (topicPolicy.mode !== 'off') {
      const policyResult = await evaluateTopicPolicy({ message: body.message, policy: topicPolicy })
      if (policyResult.rider) {
        chatMessage = `[SYSTEM: ${policyResult.rider}]\n\n${chatMessage}`
        if (policyResult.matched.length) {
          ctx.audit({
            oid: attribution.oid,
            keyId: attribution.keyId,
            event: 'policy.match',
            data: {
              session_id: sessionId,
              rules: policyResult.matched.map(r => r.id),
              classifier: policyResult.classifier,
              policy_version: topicPolicy.version,
            },
          })
        }
      }
    }
  } catch (err) {
    log.warn?.('topic_policy_eval_failed', { error: (err as Error).message })
  }

  ctx.audit({
    oid: attribution.oid,
    keyId: attribution.keyId,
    event: 'chat.started',
    data: {
      session_id: sessionId,
      model: resolvedModel || body.model || '',
      streaming,
      message_len: body.message.length,
      identity_type: identity.type,
      owner_email: attribution.email,
      tenant_id: attribution.tenantId,
    },
  })
  if (previousMessages.length === 0) {
    getRelayReporter()?.recordSessionEvent({
      type: 'session.created',
      session_id: sessionId,
      model: resolvedModel,
    })
  }
  metrics.streamOpened()

  const abortController = new AbortController()
  req.signal?.addEventListener('abort', () => abortController.abort())
  const startedAt = Date.now()
  const fallbackModels = await getFallbackChainForModel(resolvedModel)
  // Model router: intent-based cloud routing (null → local default model).
  const routeOverride = routeTurn({ text: chatMessage, channel: 'chat' }) ?? undefined

  if (!streaming) {
    const toolCalls: any[] = []
    const toolResults: any[] = []
    const toolStartTimes = new Map<string, number>()
    const userMcpServers = await listUserMcpServers(ctx.store).catch(() => [])
    let result
    try {
      result = await runAgentTurnWithFallback(
        {
          message: chatMessage,
          providerOverride: routeOverride,
          // resolvedModel honours sticky-model: if a previous turn
          // fell back successfully, we start there instead of the
          // failed primary the client originally selected.
          model: resolvedModel,
          workingDirectory,
          taskPacketJson: body.task_packet_json,
          previousMessages,
          signal: abortController.signal,
          allowedTools,
          autoApprove: () => true,
          mcpToken,
          sessionId,
          denyTools,
          outputStyle: body.output_style,
          thinkingBudget: body.thinking_budget,
          planMode: body.plan_mode === true,
          agentId: body.agent_id,
          worktree: body.worktree,
          fallbackModels,
          userMcpServers,
          extraTools: apiNativeTools,
          appendSystemPromptExtra: agentContextPrompt(),
        },
        {
          onToolStart: e => {
            metrics.recordTool(e.toolName)
            toolStartTimes.set(e.toolUseId, Date.now())
            toolCalls.push({
              tool_name: e.toolName,
              arguments: e.arguments,
              tool_use_id: e.toolUseId,
            })
            ctx.audit({
              ...attribution,
              event: 'tool.invoked',
              data: {
                session_id: sessionId,
                tool: e.toolName,
                tool_use_id: e.toolUseId,
                args_hash: hashToolArgs(e.arguments),
              },
            })
          },
          onToolResult: e => {
            const t0 = toolStartTimes.get(e.toolUseId)
            if (t0) {
              metrics.recordToolDuration(e.toolName, Date.now() - t0)
              toolStartTimes.delete(e.toolUseId)
            }
            toolResults.push({
              tool_name: e.toolName,
              tool_use_id: e.toolUseId,
              output: e.output,
              is_error: e.isError,
            })
            ctx.audit({
              ...attribution,
              event: 'tool.completed',
              data: {
                session_id: sessionId,
                tool: e.toolName,
                tool_use_id: e.toolUseId,
                is_error: e.isError === true,
                output_len: typeof e.output === 'string' ? e.output.length : -1,
              },
            })
          },
          onLog: (l, m, d) => log[l]?.(m, d as any),
        },
      )
    } catch (err) {
      metrics.streamClosed()
      metrics.recordChat(body.model || '', 'error')
      ctx.audit({
        ...attribution,
        event: 'chat.error',
        data: {
          error: (err as Error).message,
          session_id: sessionId,
          model: resolvedModel,
          owner_email: attribution.email,
          tenant_id: attribution.tenantId,
        },
      })
      return jsonResponse(500, {
        error: (err as Error).message || 'Agent run failed',
        code: 'AGENT_ERROR',
      })
    }

    metrics.streamClosed()
    metrics.recordChat(body.model || '', result.interrupted ? 'cancelled' : 'success')
    metrics.recordTokens('input', body.model || '', result.promptTokens)
    metrics.recordTokens('output', body.model || '', result.completionTokens)
    metrics.recordTurnDuration((result as any).usedModel || resolvedModel || body.model || '', Date.now() - startedAt)
    getRelayReporter()?.recordTokenUsage({
      user_oid: attribution.oid,
      user_email: attribution.email,
      tenant_id: attribution.tenantId,
      session_id: sessionId,
      model: resolvedModel, provider: 'anthropic',
      prompt_tokens: result.promptTokens, completion_tokens: result.completionTokens,
      total_tokens: result.promptTokens + result.completionTokens,
      duration_ms: Date.now() - startedAt, streaming: false,
    })
    void recordCostPoint(ctx.store, {
      session_id: sessionId,
      model: resolvedModel,
      prompt_tokens: result.promptTokens,
      completion_tokens: result.completionTokens,
      duration_ms: Date.now() - startedAt,
      recorded_at: new Date().toISOString(),
      owner_oid: attribution.oid,
      owner_email: attribution.email,
      key_id: attribution.keyId,
      tenant_id: attribution.tenantId,
    })

    await ctx.store.setSession(sessionId, result.finalMessages, ctx.sessionTtlSeconds)
    await ctx.store.setSessionMeta(
      sessionId,
      {
        ownerOid: attribution.oid ?? '',
        model: body.model || '',
        last_message_at: new Date().toISOString(),
        title: deriveSessionTitle(result.finalMessages, body.message),
      },
      ctx.sessionTtlSeconds,
    )

    ctx.audit({
      ...attribution,
      event: 'chat.completed',
      latencyMs: Date.now() - startedAt,
      data: {
        session_id: sessionId,
        model: resolvedModel,
        prompt_tokens: result.promptTokens,
        completion_tokens: result.completionTokens,
        cost_usd: dollars(resolvedModel, result.promptTokens, result.completionTokens),
        duration_ms: Date.now() - startedAt,
        owner_email: attribution.email,
        tenant_id: attribution.tenantId,
      },
    })
    getRelayReporter()?.recordSessionEvent({
      type: 'session.completed',
      session_id: sessionId,
      model: resolvedModel,
      prompt_tokens: result.promptTokens,
      completion_tokens: result.completionTokens,
      duration_ms: Date.now() - startedAt,
    })

    // Fire-and-forget: extract memories from this turn
    maybeExtractMemories(sessionId, result.finalMessages, ctx.store, body.model)
      .catch(err => console.error(`[chat] extraction error:`, err))

    return jsonResponse(200, {
      session_id: sessionId,
      full_text: result.fullText,
      tool_calls: toolCalls,
      tool_results: toolResults,
      usage: {
        prompt_tokens: result.promptTokens,
        completion_tokens: result.completionTokens,
      },
    })
  }

  // ─── SSE streaming ───
  // include_thinking is opt-in: the client must explicitly set it to true
  // to receive `event: thinking` SSE chunks. Default-off keeps Claude's
  // extended-thinking content out of UIs that aren't built to surface it.
  const includeThinking = body.include_thinking === true
  const includeActivity = body.include_activity !== false
  const sse = createSse({ onAbort: () => abortController.abort() })
  const canvasToolArgs = new Map<string, { action?: string; entry?: string }>()
  const toolStartTimes = new Map<string, number>()
  const hooks: AgentRunHooks = {
    onTextChunk: text => { sse.send('text_chunk', { text }) },
    onToolStart: e => {
      metrics.recordTool(e.toolName)
      toolStartTimes.set(e.toolUseId, Date.now())
      sse.send('tool_start', e)
      if (e.toolName === 'Canvas') {
        const a = e.arguments as { action?: string; entry?: string } | null
        if (a && typeof a.action === 'string') {
          canvasToolArgs.set(e.toolUseId, { action: a.action, entry: a.entry })
        }
      }
      if (includeActivity) {
        sse.send('activity', {
          verb: toolVerb(e.toolName),
          target: toolTarget(e.toolName, e.arguments),
          toolName: e.toolName,
          phase: 'start',
        })
      }
      ctx.audit({
        ...attribution,
        event: 'tool.invoked',
        data: {
          session_id: sessionId,
          tool: e.toolName,
          tool_use_id: e.toolUseId,
          args_hash: hashToolArgs(e.arguments),
        },
      })
    },
    onToolResult: e => {
      const t0 = toolStartTimes.get(e.toolUseId)
      if (t0) {
        metrics.recordToolDuration(e.toolName, Date.now() - t0)
        toolStartTimes.delete(e.toolUseId)
      }
      sse.send('tool_result', e)
      // Canvas tool integration: emit canvas_open / canvas_close SSE events
      // based on the action the agent invoked Canvas with. Output is
      // serialized to a string by the worker, so we trust the args we
      // captured at tool_start time + the success status here.
      if (e.toolName === 'Canvas' && !e.isError) {
        const args = canvasToolArgs.get(e.toolUseId)
        canvasToolArgs.delete(e.toolUseId)
        if (args?.action === 'open') {
          const entry = args.entry ?? 'index.html'
          // Try to extract a preview_url from the output text first (in
          // case it's been routed through a canvas pod). Fall back to
          // the static workspace path served by this router.
          // Serve from the real session workspace where the files actually
          // land. The tool reports a "tmp" placeholder path that does NOT
          // match the API's serving path (the cause of the blank canvas), so
          // only honour an absolute pod URL — never the tool's static path.
          let previewUrl = `/v1/workspace/${sessionId}/.canvas/${entry}`
          if (typeof e.output === 'string') {
            const m = e.output.match(/preview_url:\s*(https?:\/\/\S+)/)
            if (m) previewUrl = m[1]
          }
          sse.send('canvas_open', {
            session_id: sessionId,
            preview_url: previewUrl,
            file: entry,
          })
        } else if (args?.action === 'close') {
          sse.send('canvas_close', { session_id: sessionId })
        } else if (args?.action === 'write_files') {
          // Re-writing files without re-opening should still refresh
          // the live preview iframe in the frontend.
          sse.send('canvas_refresh', { session_id: sessionId })
        }
      }
      if (includeActivity) {
        sse.send('activity', {
          verb: toolVerb(e.toolName),
          target: toolTarget(e.toolName, null),
          toolName: e.toolName,
          phase: e.isError ? 'error' : 'complete',
        })
      }
      ctx.audit({
        ...attribution,
        event: 'tool.completed',
        data: {
          session_id: sessionId,
          tool: e.toolName,
          tool_use_id: e.toolUseId,
          is_error: e.isError === true,
          output_len: typeof e.output === 'string' ? e.output.length : -1,
        },
      })
    },
    onThinking: includeThinking
      ? ev => { sse.send('thinking', { text: ev.text, summary: summarizeThinking(ev.text) }) }
      : undefined,
    onLog: (level, msg, data) => log[level]?.(msg, data as any),
  }
  sse.send('session', { session_id: sessionId })

  // Forward typed widgets emitted by the Widget tool during this turn.
  const { onWidget } = await import('./widgets/bus.js')
  const unsubWidgets = onWidget(sessionId, spec => sse.send('widget', spec))

  // Canvas mode: route to a long-lived canvas pod with Vite preview.
  const canvasRequested = !!body.canvas
  const canvasTemplate: CanvasTemplate =
    (typeof body.canvas === 'object' && body.canvas?.template) || 'react-ts'

  ;(async () => {
    try {
      let result: { fullText: string; promptTokens: number; completionTokens: number; finalMessages: unknown[]; interrupted?: boolean }
      const userMcpServers = await listUserMcpServers(ctx.store).catch(() => [])

      if (canvasRequested && isCanvasModeEnabled()) {
        let canvasInfo = await getCanvasPod(ctx.store, sessionId)
        if (!canvasInfo) {
          sse.send('activity', { verb: 'Starting', target: 'canvas environment' })
          canvasInfo = await createCanvasPod(ctx.store, sessionId, {
            ...DEFAULT_CANVAS_CONFIG,
            template: canvasTemplate,
            runtimeClassName: process.env.ORB2_CANVAS_RUNTIME_CLASS || undefined,
          })
        }
        sse.send('canvas_ready', {
          session_id: sessionId,
          preview_url: `/v1/preview/${sessionId}/`,
          template: canvasInfo.template,
          pod_name: canvasInfo.podName,
        })

        // Route the turn to the canvas pod.
        const { routeToCanvasPod } = await import('./canvas/dispatch.js')
        const canvasResult = await routeToCanvasPod(canvasInfo, {
          message: chatMessage,
          model: resolvedModel,
          previousMessages,
          mcpToken,
          sessionId,
          fallbackModels,
        })
        result = canvasResult as any

      } else {

      const useWorker = isWorkerModeEnabled()
      if (useWorker) {
        const turnId = _wd_randomUUID()
        try {
          const palettes = await buildWorkerPalettes(ctx.store)
          const gitCredentials = await buildGitCredentials(ctx.store, attribution.oid)
          await launchWorkerJob(ctx.store, turnId, {
            taskId: turnId,
            sessionId,
            message: chatMessage,
            model: resolvedModel,
            mcpToken,
            previousMessages,
            workingDirectory,
            fallbackModels,
            knobs: {
              outputStyle: body.output_style,
              thinkingBudget: body.thinking_budget,
              planMode: body.plan_mode === true,
              denyTools,
              allowedTools: allowedTools ? Array.from(allowedTools) : undefined,
              agentId: body.agent_id,
              worktree: body.worktree,
            },
            ...palettes,
            ...(gitCredentials && { gitCredentials }),
          })
          // Stream events from the worker through the SSE hooks.
          let final: { fullText: string; promptTokens: number; completionTokens: number; finalMessages: unknown[]; usedModel?: string } | null = null
          let lastError: string | null = null
          for await (const ev of subscribeToWorker(ctx.store, turnId, 600_000, sessionId)) {
            if (ev.type === 'text_chunk') hooks.onTextChunk?.(ev.text)
            else if (ev.type === 'tool_start') {
              hooks.onToolStart?.({ toolName: ev.toolName, toolUseId: ev.toolUseId, arguments: ev.arguments })
            } else if (ev.type === 'tool_result') {
              hooks.onToolResult?.({ toolName: ev.toolName, toolUseId: ev.toolUseId, output: ev.output, isError: ev.isError })
            } else if (ev.type === 'done') {
              final = { fullText: ev.fullText, promptTokens: ev.promptTokens, completionTokens: ev.completionTokens, finalMessages: ev.finalMessages as unknown[], usedModel: ev.usedModel }
            } else if (ev.type === 'error') {
              lastError = ev.message
              break
            }
          }
          if (final) {
            result = final
          } else {
            throw new Error(lastError ?? 'Worker exited without producing a result')
          }
        } catch (err) {
          // Graceful fallback: in-process execution if dispatch failed.
          log.warn?.('worker_dispatch_fallback', { error: (err as Error).message })
          result = await runAgentTurn(
            {
              message: chatMessage,
              providerOverride: routeOverride,
              model: resolvedModel,
              workingDirectory,
              taskPacketJson: body.task_packet_json,
              previousMessages,
              signal: abortController.signal,
              allowedTools,
              autoApprove: () => true,
              mcpToken,
              extraTools: apiNativeTools,
              appendSystemPromptExtra: agentContextPrompt(),
            },
            hooks,
          )
        }
      } else {
        result = await runAgentTurnWithFallback(
          {
            message: chatMessage,
            providerOverride: routeOverride,
            model: resolvedModel,
            workingDirectory,
            taskPacketJson: body.task_packet_json,
            previousMessages,
            signal: abortController.signal,
            allowedTools,
            autoApprove: () => true,
            mcpToken,
            sessionId,
            denyTools,
            outputStyle: body.output_style,
            thinkingBudget: body.thinking_budget,
            planMode: body.plan_mode === true,
            agentId: body.agent_id,
            worktree: body.worktree,
            fallbackModels,
            userMcpServers,
            extraTools: apiNativeTools,
          },
          hooks,
        )
      }
      } // end of canvas else branch

      // Sticky model + frontend indicator: if the agent fell back to
      // a different model than the one we requested, persist that on
      // the session so the next turn starts there, and tell the
      // frontend so the dropdown reflects reality.
      const effectiveModel = ((result as any).usedModel as string | undefined) || resolvedModel
      if (effectiveModel && effectiveModel !== resolvedModel) {
        sse.send('model_switched', {
          session_id: sessionId,
          from: resolvedModel,
          to: effectiveModel,
        })
      }
      await ctx.store.setSession(sessionId, result.finalMessages, ctx.sessionTtlSeconds)
      await ctx.store.setSessionMeta(
        sessionId,
        {
          ownerOid: attribution.oid ?? '',
          // Persist the model that actually produced the turn — that
          // way the next request can pick up where we left off
          // without re-trying the failed primary on every turn.
          model: effectiveModel,
          last_message_at: new Date().toISOString(),
          title: deriveSessionTitle(result.finalMessages as any, body.message),
        },
        ctx.sessionTtlSeconds,
      )
      sse.send('done', {
        full_text: result.fullText,
        prompt_tokens: result.promptTokens,
        completion_tokens: result.completionTokens,
      })
      metrics.recordChat(body.model || '', result.interrupted ? 'cancelled' : 'success')
      metrics.recordTokens('input', body.model || '', result.promptTokens)
      metrics.recordTokens('output', body.model || '', result.completionTokens)
      metrics.recordTurnDuration((result as any).usedModel || resolvedModel || body.model || '', Date.now() - startedAt)
      getRelayReporter()?.recordTokenUsage({
        user_oid: attribution.oid,
        user_email: attribution.email,
        tenant_id: attribution.tenantId,
        session_id: sessionId,
        model: resolvedModel, provider: 'anthropic',
        prompt_tokens: result.promptTokens, completion_tokens: result.completionTokens,
        total_tokens: result.promptTokens + result.completionTokens,
        duration_ms: Date.now() - startedAt, streaming: true,
      })
      void recordCostPoint(ctx.store, {
        session_id: sessionId,
        model: resolvedModel,
        prompt_tokens: result.promptTokens,
        completion_tokens: result.completionTokens,
        duration_ms: Date.now() - startedAt,
        recorded_at: new Date().toISOString(),
        owner_oid: attribution.oid,
        owner_email: attribution.email,
        key_id: attribution.keyId,
        tenant_id: attribution.tenantId,
      })
      ctx.audit({
        ...attribution,
        event: 'chat.completed',
        latencyMs: Date.now() - startedAt,
        data: {
          session_id: sessionId,
          model: resolvedModel,
          prompt_tokens: result.promptTokens,
          completion_tokens: result.completionTokens,
          cost_usd: dollars(resolvedModel, result.promptTokens, result.completionTokens),
          duration_ms: Date.now() - startedAt,
          streaming: true,
          owner_email: attribution.email,
          tenant_id: attribution.tenantId,
        },
      })
      getRelayReporter()?.recordSessionEvent({
        type: 'session.completed',
        session_id: sessionId,
        model: resolvedModel,
        prompt_tokens: result.promptTokens,
        completion_tokens: result.completionTokens,
        duration_ms: Date.now() - startedAt,
      })

      // Fire-and-forget: extract memories from this turn
      maybeExtractMemories(sessionId, result.finalMessages, ctx.store, body.model)
        .catch(err => console.error(`[chat] extraction error:`, err))
    } catch (err) {
      metrics.recordChat(body.model || '', 'error')
      sse.send('error', {
        error: (err as Error).message || 'Agent run failed',
        code: 'AGENT_ERROR',
      })
      ctx.audit({
        ...attribution,
        event: 'chat.error',
        data: {
          error: (err as Error).message,
          session_id: sessionId,
          model: resolvedModel,
          owner_email: attribution.email,
          tenant_id: attribution.tenantId,
        },
      })
    } finally {
      metrics.streamClosed()
      unsubWidgets()
      sse.close()
    }
  })()

  return new Response(sse.readable, {
    status: 200,
    headers: SSE_RESPONSE_HEADERS,
  })
}

// ─────────────────────── Sessions ───────────────────────
function deriveSessionTitle(
  messages: Array<{ role: string; content: unknown }> | undefined,
  fallback: string,
): string {
  const firstUser = (messages || []).find(m => m.role === 'user')
  let raw = ''
  if (firstUser) {
    const c = firstUser.content
    if (typeof c === 'string') raw = c
    else if (Array.isArray(c)) {
      for (const p of c) {
        if (p && typeof p === 'object' && 'text' in p && typeof (p as any).text === 'string') {
          raw = (p as any).text
          break
        }
      }
    }
  }
  if (!raw && typeof fallback === 'string') raw = fallback
  raw = raw.replace(/\s+/g, ' ').trim()
  if (raw.length > 80) raw = raw.slice(0, 77) + '...'
  return raw || 'Untitled session'
}

async function handleListSessions(
  identity: CallerIdentity,
  ctx: RuntimeContext,
): Promise<Response> {
  const ownerOid = attributionFor(identity).oid ?? ''
  const ids = await ctx.store.listSessionsForOwner(ownerOid)
  const metas = await Promise.all(ids.map(id => ctx.store.getSessionMeta(id)))
  const sessions = ids.map((id, i) => ({ id, meta: metas[i] ?? {} }))
  sessions.sort((a, b) => {
    const ta = (a.meta?.last_message_at as string) || ''
    const tb = (b.meta?.last_message_at as string) || ''
    return tb.localeCompare(ta)
  })
  return jsonResponse(200, { sessions })
}

async function handleGetSession(
  id: string,
  identity: CallerIdentity,
  ctx: RuntimeContext,
): Promise<Response> {
  const meta = await ctx.store.getSessionMeta(id)
  const ownerOid = attributionFor(identity).oid ?? ''
  if (meta?.ownerOid && meta.ownerOid !== ownerOid && !isAdmin(identity)) {
    return jsonResponse(403, { error: 'Not your session' })
  }
  const messages = (await ctx.store.getSession(id)) ?? []
  return jsonResponse(200, { id, meta, messages })
}

async function handleDeleteSession(
  id: string,
  identity: CallerIdentity,
  ctx: RuntimeContext,
): Promise<Response> {
  const meta = await ctx.store.getSessionMeta(id)
  const ownerOid = attributionFor(identity).oid ?? ''
  if (meta?.ownerOid && meta.ownerOid !== ownerOid && !isAdmin(identity)) {
    return jsonResponse(403, { error: 'Not your session' })
  }
  await ctx.store.delSession(id)
  return new Response(null, { status: 204 })
}

// ─────────────────────── Audit ───────────────────────
async function handleAudit(
  url: URL,
  _identity: CallerIdentity,
  ctx: RuntimeContext,
): Promise<Response> {
  const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10)
  const limit = Math.min(
    1000,
    Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10) || 200),
  )
  const events = await ctx.store.tailAudit(date, limit)
  return jsonResponse(200, { date, events })
}

// ─────────────────────── Helpers ───────────────────────
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return null
  }
}

function identitySummary(id: CallerIdentity) {
  if (id.type === 'apikey') {
    return {
      type: 'apikey',
      key_id: id.record.id,
      owner_email: id.record.ownerEmail,
      admin: id.record.admin === true,
    }
  }
  if (id.type === 'service') return { type: 'service', agent_id: id.agentId }
  return { type: 'user', username: id.username }
}

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
}

function serveStatic(dir: string, name: string): Response {
  const safe = name.replace(/\\/g, '/').replace(/\.\.+/g, '.')
  const root = path.resolve(dir)
  const full = path.resolve(root, safe)
  if (!full.startsWith(root)) {
    return jsonResponse(404, { error: 'Not Found' })
  }
  if (!existsSync(full)) {
    return jsonResponse(404, { error: 'Not Found' })
  }
  const ext = path.extname(full).toLowerCase()
  const mime = STATIC_TYPES[ext] || 'application/octet-stream'
  const data = readFileSync(full)
  // Console assets change frequently during deploys; long max-age silently
  // strands users on stale CSS / JS / images after a roll. Treat the entire
  // /web/ surface as no-cache so a hard reload picks up the new bundle. If
  // the project ever ships through a CDN with content-hashed asset names,
  // we can re-tighten this per extension.
  const cacheControl = 'no-cache, no-store, must-revalidate'
  return new Response(data, {
    status: 200,
    headers: { 'content-type': mime, 'cache-control': cacheControl },
  })
}

function ensureDir(dir: string) {
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* best-effort */
  }
}
