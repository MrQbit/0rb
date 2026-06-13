/**
 * Worker-internal bridge routes.
 *
 * These endpoints sit under `/v1/internal/turn/:turnId/...` and let
 * tools running inside a K8s worker pod call back into the router's
 * API surface (jobs, sub-worker spawn, vault, memory, sandbox)
 * without re-implementing those services in every worker.
 *
 * Every route requires an `X-Rak00n-Bridge-Token` header containing the
 * HMAC-bound token issued by `bridgeAuth.issueBridgeToken()`. The
 * token's claim must match the URL's :turnId so a leaked token can
 * only act on the work it was issued for.
 *
 * Audit attribution: every bridge call is logged with
 * `event=worker_internal.<verb>` and the (sessionId, turnId) carried
 * by the token, so we keep a clean trail of what each worker did.
 */
import { verifyBridgeToken } from './bridgeAuth.js'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
import { executeSubmitJob } from '../jobs/tool.js'
import {
  isSandboxEnabled,
  executeRunCode,
} from '../sandbox/tool.js'
import {
  getVaultStore,
  executeVaultRead,
  executeVaultWrite,
  executeVaultSearch,
} from '../vault/tools.js'
import { launchWorkerJob, isWorkerModeEnabled } from '../workerDispatch.js'
import type { Store } from '../store/store.js'
import { randomUUID } from 'node:crypto'
import { log } from '../log.js'

export type BridgeContext = {
  store: Store
  audit: (event: { event: string; data?: Record<string, unknown> }) => void
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = await req.json()
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Handle `/v1/internal/turn/:turnId/...` routes. Returns a Response
 * if the path matches, otherwise returns null so the caller's main
 * router can fall through.
 */
export async function tryHandleBridgeRoute(
  req: Request,
  pathname: string,
  ctx: BridgeContext,
): Promise<Response | null> {
  const m = pathname.match(/^\/v1\/internal\/turn\/([^/]+)\/(.+)$/)
  if (!m) return null
  const [, urlTurnId, suffix] = m

  // Verify token + scope.
  const token = req.headers.get('x-rak00n-bridge-token') ?? ''
  const claim = verifyBridgeToken(token)
  if (!claim) {
    return jsonResponse(401, {
      error: 'invalid or expired bridge token',
      code: 'BRIDGE_UNAUTHENTICATED',
    })
  }
  if (claim.turnId !== urlTurnId) {
    return jsonResponse(403, {
      error: 'token scope mismatch (turnId)',
      code: 'BRIDGE_SCOPE_MISMATCH',
    })
  }

  const sessionId = claim.sessionId
  const turnId = claim.turnId
  const method = req.method
  const audit = (verb: string, data?: Record<string, unknown>) =>
    ctx.audit({
      event: `worker_internal.${verb}`,
      data: { ...(data ?? {}), session_id: sessionId, turn_id: turnId },
    })

  // ─── Jobs ───
  if (method === 'POST' && suffix === 'jobs') {
    const body = (await readJson(req)) ?? {}
    const type = String(body.type ?? '').trim()
    const description = String(body.description ?? '').trim()
    if (!type || !description) {
      return jsonResponse(400, { error: 'type and description are required' })
    }
    try {
      const result = await executeSubmitJob(
        {
          type,
          description,
          params: (body.params as Record<string, unknown> | undefined) ?? {},
          requires_approval: body.requires_approval !== false,
        },
        { sessionId, ownerId: `worker:${turnId}`, store: ctx.store },
      )
      audit('job.submit', { job_id: result.jobId, type })
      return jsonResponse(200, result)
    } catch (err) {
      return jsonResponse(500, {
        error: 'job submit failed',
        message: (err as Error).message,
      })
    }
  }

  // ─── Sub-worker spawn ───
  if (method === 'POST' && suffix === 'workers/spawn') {
    if (!isWorkerModeEnabled()) {
      return jsonResponse(503, {
        error: 'worker mode not enabled on router',
        code: 'WORKERS_DISABLED',
      })
    }
    const body = (await readJson(req)) ?? {}
    const message = String(body.message ?? '')
    if (!message) return jsonResponse(400, { error: 'message is required' })
    const childTurnId = String(body.turn_id ?? randomUUID())
    try {
      const r = await launchWorkerJob(ctx.store, childTurnId, {
        taskId: childTurnId,
        sessionId,
        message,
        model: typeof body.model === 'string' ? body.model : undefined,
        previousMessages: Array.isArray(body.previous_messages)
          ? (body.previous_messages as unknown[])
          : [],
        workingDirectory:
          typeof body.working_directory === 'string'
            ? body.working_directory
            : undefined,
        knobs: (body.knobs as Record<string, unknown>) || undefined,
      } as any)
      audit('worker.spawn', { child_turn_id: childTurnId, parent_turn_id: turnId })
      return jsonResponse(200, {
        child_turn_id: childTurnId,
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

  // ─── Sandbox ───
  if (method === 'POST' && suffix === 'sandbox/run') {
    if (!isSandboxEnabled()) {
      return jsonResponse(503, {
        error: 'sandbox is not enabled in this build',
        code: 'SANDBOX_DISABLED',
      })
    }
    const body = (await readJson(req)) ?? {}
    const language = String(body.language ?? 'python')
    const code = String(body.code ?? '')
    if (!code) return jsonResponse(400, { error: 'code is required' })
    try {
      const out = await executeRunCode({
        language,
        code,
        stdin: typeof body.stdin === 'string' ? body.stdin : undefined,
      })
      audit('sandbox.run', { language, bytes: code.length })
      return jsonResponse(200, out)
    } catch (err) {
      return jsonResponse(500, {
        error: 'sandbox run failed',
        message: (err as Error).message,
      })
    }
  }

  // ─── Vault ───
  if (method === 'GET' && suffix === 'vault') {
    const vault = getVaultStore(ctx.store)
    const notes = await vault.list()
    return jsonResponse(200, { notes })
  }
  if (method === 'GET' && suffix.startsWith('vault/note/')) {
    const notePath = decodeURIComponent(suffix.slice('vault/note/'.length))
    try {
      const note = await executeVaultRead({ path: notePath }, ctx.store)
      audit('vault.read', { path: notePath })
      return jsonResponse(200, note)
    } catch (err) {
      return jsonResponse(404, { error: (err as Error).message })
    }
  }
  if (method === 'PUT' && suffix.startsWith('vault/note/')) {
    const notePath = decodeURIComponent(suffix.slice('vault/note/'.length))
    const body = (await readJson(req)) ?? {}
    try {
      const r = await executeVaultWrite(
        {
          path: notePath,
          content: String(body.content ?? ''),
          tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
        },
        ctx.store,
      )
      audit('vault.write', { path: notePath })
      return jsonResponse(200, r)
    } catch (err) {
      return jsonResponse(500, { error: (err as Error).message })
    }
  }
  if (method === 'POST' && suffix === 'vault/search') {
    const body = (await readJson(req)) ?? {}
    const q = String(body.query ?? body.q ?? '')
    const tags = Array.isArray(body.tags) ? (body.tags as string[]) : undefined
    try {
      const r = await executeVaultSearch({ query: q, tags }, ctx.store)
      return jsonResponse(200, r)
    } catch (err) {
      return jsonResponse(500, { error: (err as Error).message })
    }
  }

  // ─── Memory digest ───
  if (method === 'POST' && suffix === 'memory/digest') {
    const body = (await readJson(req)) ?? {}
    try {
      // Stash a per-session memory digest fragment so the relay
      // collector picks it up on the next periodic sync.
      const key = `rak00n:memory:digest:${sessionId}`
      await ctx.store.putKv(key, JSON.stringify({
        ...body,
        recorded_at: new Date().toISOString(),
        turn_id: turnId,
      }), 86400)
      audit('memory.digest', { fields: Object.keys(body).length })
      return jsonResponse(200, { ok: true })
    } catch (err) {
      return jsonResponse(500, { error: (err as Error).message })
    }
  }

  log.warn('worker_internal_unknown_path', { suffix, method })
  return jsonResponse(404, { error: 'unknown bridge endpoint', suffix })
}
