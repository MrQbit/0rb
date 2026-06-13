/**
 * Worker dispatch — creates a K8s Job for each agent turn and proxies
 * events back to the caller via Redis Pub/Sub.
 *
 * When RAK00N_WORKER_MODE=k8s-jobs, handleChat/a2a/requestConsumer call
 * dispatchToWorker() instead of runAgentTurn() directly. The Job pod
 * runs the same image with RAK00N_MODE=worker, executes one turn, and
 * exits. Session state lives in Redis, filesystem is ephemeral.
 *
 * Fallback: if Job creation fails or worker mode is off, callers
 * fall back to in-process runAgentTurn().
 */
import { randomUUID } from 'node:crypto'
import type { Store } from './store/store.js'
import { log } from './log.js'

const WORKER_CHANNEL_PREFIX = 'rak00n:stream:'
const WORKER_STATE_PREFIX = 'rak00n:worker:'
const DEFAULT_TIMEOUT_MS = 600_000 // 10 min

export type WorkerKnobs = {
  outputStyle?: string
  thinkingBudget?: number
  planMode?: boolean
  denyTools?: string[]
  allowedTools?: string[]
  agentId?: string
  worktree?: { branch?: string; root?: string }
  /**
   * Inline sub-agent definition. When set, the worker registers an
   * ad-hoc CustomAgentDefinition with this prompt/tools/model before
   * running the turn. Lets a router pod (or another worker via
   * `bridge.spawnSubWorker`) hand the worker a one-off specialist
   * without round-tripping through Redis or the FS mirror.
   */
  agentDefinition?: {
    name: string
    description: string
    prompt: string
    tools?: string[]
    model?: string
  }
}

export type AgentPaletteEntry = {
  id: string
  name: string
  description: string
  prompt: string
  tools?: string[]
  model?: string
  source: 'dynamic' | 'discovered'
}

export type McpPaletteEntry = {
  name: string
  config: Record<string, unknown>
  source: 'discovered'
}

export type SkillPaletteEntry = {
  name: string
  description: string
  instructions: string
  source: 'discovered'
}

export type WorkerTask = {
  taskId: string
  sessionId: string
  message: string
  model?: string
  mcpToken?: string
  previousMessages: unknown[]
  workingDirectory?: string
  fallbackModels?: string[]
  knobs?: WorkerKnobs
  /**
   * Snapshot of the agent + MCP palette at dispatch time. The worker
   * materializes these into <cwd>/.rak00n/agents/*.md + a synthesized
   * .mcp.json before runAgentTurn so the standard loaders pick them
   * up. Discovery and dynamic-agent edits made *after* dispatch are
   * picked up by the next turn (no live reload mid-turn).
   */
  agentPalette?: AgentPaletteEntry[]
  mcpPalette?: McpPaletteEntry[]
  skillsPalette?: SkillPaletteEntry[]
  /**
   * Internal bridge token. Lets a tool running inside the worker pod
   * call back into the router's API surface (jobs, sub-worker spawn,
   * MCP admin, sandbox, vault) using a short-lived HMAC. Forwarded
   * via the K8s Job's RAK00N_INTERNAL_TOKEN env var.
   */
  bridgeToken?: string
  bridgeUrl?: string
  /**
   * Short-lived github.com push credential. The router mints a GitHub
   * App installation token before dispatch and the worker writes it
   * into git config so any `git push` the agent runs authenticates as
   * the App. Avoids needing per-user PATs and avoids sending the
   * caller's Entra bearer to github.com (which github.com rejects).
   * Token TTL is ~1h; the worker job's deadline is shorter so we don't
   * need a refresh loop.
   */
  gitCredentials?: {
    host: string
    username: string
    password: string
    expiresAt: string
  }
}

export type WorkerEvent =
  | { type: 'text_chunk'; text: string }
  | { type: 'tool_start'; toolName: string; toolUseId: string; arguments: unknown }
  | { type: 'tool_result'; toolName: string; toolUseId: string; output: string; isError: boolean }
  | { type: 'done'; fullText: string; promptTokens: number; completionTokens: number; finalMessages: unknown[]; usedModel?: string }
  | { type: 'error'; message: string }

export function isWorkerModeEnabled(): boolean {
  return process.env.RAK00N_WORKER_MODE === 'k8s-jobs'
}

/**
 * Publish a worker event to the per-turn Redis list.
 * Called by the worker entrypoint. Every event is appended; the
 * consumer drains the list. Terminal events (done/error) are also
 * mirrored to a single-key state slot for late-attaching readers.
 */
export async function publishWorkerEvent(
  store: Store,
  sessionId: string,
  turnId: string,
  event: WorkerEvent,
): Promise<void> {
  const listKey = `${WORKER_CHANNEL_PREFIX}${sessionId}:${turnId}`
  const payload = JSON.stringify(event)
  await store.pushList(listKey, payload, 600)
  if (event.type === 'done' || event.type === 'error') {
    await store.putKv(`${WORKER_STATE_PREFIX}${turnId}`, payload, 600)
  }
}

/**
 * Drain worker events for a turn. Yields every queued event in order
 * and stops on the first terminal event (done/error) or after
 * `timeoutMs` of no progress. Uses RPOP/LRANGE-based polling against
 * the per-turn Redis list -- losses are impossible because the worker
 * appends instead of overwriting.
 */
export async function* subscribeToWorker(
  store: Store,
  turnId: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  sessionId?: string,
): AsyncGenerator<WorkerEvent> {
  // sessionId is required: per-session keying is the cross-user
  // isolation guarantee. A wildcard would let any caller drain another
  // session's events. Reject early so the typo can never ship.
  if (!sessionId || typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('subscribeToWorker requires sessionId')
  }
  const listKey = `${WORKER_CHANNEL_PREFIX}${sessionId}:${turnId}`
  const stateKey = `${WORKER_STATE_PREFIX}${turnId}`
  const startedAt = Date.now()
  const pollInterval = 250

  while (Date.now() - startedAt < timeoutMs) {
    const batch = await store.popListAll(listKey, 200)
    if (batch.length > 0) {
      for (const raw of batch) {
        let event: WorkerEvent
        try { event = JSON.parse(raw) as WorkerEvent } catch { continue }
        yield event
        if (event.type === 'done' || event.type === 'error') return
      }
      continue // immediately re-poll after a non-empty batch
    }
    // No events queued -- check for a terminal state mirror in case we
    // arrived after the worker exited.
    const terminal = await store.getKv(stateKey)
    if (terminal) {
      try {
        const event = JSON.parse(terminal) as WorkerEvent
        yield event
        if (event.type === 'done' || event.type === 'error') return
      } catch { /* ignore */ }
    }
    await new Promise(r => setTimeout(r, pollInterval))
  }

  yield { type: 'error', message: `Worker timeout after ${timeoutMs}ms` }
}

/**
 * Check if the worker for a turn has completed.
 */
export async function getWorkerResult(
  store: Store,
  turnId: string,
): Promise<WorkerEvent | null> {
  const raw = await store.getKv(`${WORKER_STATE_PREFIX}${turnId}`)
  return raw ? JSON.parse(raw) : null
}

/**
 * Store the task payload in Redis for the worker pod to pick up.
 * Idempotent: if a task for this turnId is already enqueued (or has
 * already been claimed by a worker), the call is a no-op.
 */
export async function enqueueWorkerTask(
  store: Store,
  turnId: string,
  task: WorkerTask,
): Promise<void> {
  const key = `rak00n:task:${turnId}`
  const existing = await store.getKv(key)
  if (existing) {
    log.warn('worker_task_already_enqueued', { turnId, sessionId: task.sessionId })
    return
  }
  await store.putKv(key, JSON.stringify(task), DEFAULT_TIMEOUT_MS / 1000)
  log.info('worker_task_enqueued', { turnId, sessionId: task.sessionId })
}

/**
 * Retrieve and consume the task payload from Redis. Atomic so that
 * two worker pods racing for the same turnId can never both succeed.
 * Called by the worker entrypoint.
 */
export async function dequeueWorkerTask(
  store: Store,
  turnId: string,
): Promise<WorkerTask | null> {
  const raw = await store.getDelKv(`rak00n:task:${turnId}`)
  if (!raw) return null
  return JSON.parse(raw)
}

// ─── Worker count tracking ───
const WORKER_ACTIVE_KEY = 'rak00n:workers:active'
const WORKER_TOTAL_KEY = 'rak00n:workers:total'

export async function incrementWorkerCount(store: Store): Promise<void> {
  const active = parseInt(await store.getKv(WORKER_ACTIVE_KEY) || '0', 10)
  const total = parseInt(await store.getKv(WORKER_TOTAL_KEY) || '0', 10)
  await store.putKv(WORKER_ACTIVE_KEY, String(active + 1), 0)
  await store.putKv(WORKER_TOTAL_KEY, String(total + 1), 0)
}

export async function decrementWorkerCount(store: Store): Promise<void> {
  const active = parseInt(await store.getKv(WORKER_ACTIVE_KEY) || '0', 10)
  await store.putKv(WORKER_ACTIVE_KEY, String(Math.max(0, active - 1)), 0)
}

export async function getWorkerStats(store: Store): Promise<{ active: number; total: number }> {
  return {
    active: parseInt(await store.getKv(WORKER_ACTIVE_KEY) || '0', 10),
    total: parseInt(await store.getKv(WORKER_TOTAL_KEY) || '0', 10),
  }
}

/**
 * Launch a K8s Job for a worker turn. Uses the K8s REST API directly
 * (no client library needed — the in-cluster service account token
 * provides authentication).
 */
export async function launchWorkerJob(
  store: Store,
  turnId: string,
  task: WorkerTask,
): Promise<{ jobName: string; reused?: boolean }> {
  const namespace = process.env.RAK00N_WORKER_NAMESPACE || 'rak00n'
  const image = process.env.RAK00N_WORKER_IMAGE || 'rak00n-api:dev'
  const sa = process.env.RAK00N_WORKER_SA || 'rak00n-api'
  const redisUrl = process.env.REDIS_URL || ''
  const foundryKey = process.env.ANTHROPIC_FOUNDRY_API_KEY || ''
  const foundryUrl = process.env.ANTHROPIC_FOUNDRY_BASE_URL || ''
  const internalApiUrl =
    process.env.RAK00N_INTERNAL_API_URL ||
    `http://rak00n-api.${namespace}.svc.cluster.local:8080`
  // Mint a short-lived HMAC-bound token so router-side endpoints
  // can authenticate the worker without sharing a long-lived key.
  const { issueBridgeToken } = await import('./internal/bridgeAuth.js')
  const bridgeToken = issueBridgeToken(task.sessionId, turnId)

  // Idempotent claim: only one router pod gets to spawn the Job for
  // a given turnId. A duplicate dispatch becomes a no-op so retried
  // requests don't double-charge or double-stream.
  const claimed = await store.claim(`rak00n:turn:claimed:${turnId}`, 600)
  if (!claimed) {
    log.warn('worker_job_dispatch_skipped_already_claimed', { turnId, sessionId: task.sessionId })
    return { jobName: `rak00n-worker-${turnId.slice(0, 8)}`, reused: true }
  }

  // Enqueue task to Redis first
  await enqueueWorkerTask(store, turnId, task)

  const jobName = `rak00n-worker-${turnId.slice(0, 8)}`

  // Read in-cluster credentials
  const { readFileSync } = await import('node:fs')
  const token = readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf-8').trim()
  const caCert = readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt', 'utf-8')
  const apiServer = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`

  // When the operator wires a shared files PVC (set via the helm
  // chart's files.persistence block), the worker pod gets the SAME
  // volume mounted at the SAME path the api uses for uploads. Without
  // this, a chat that includes an uploaded file ends up with the
  // agent looking for /workspace/rak00n-files/<sid>/uploads/<id>-<name>
  // and finding nothing -- the file lives in the api pod's emptyDir.
  // The mount path defaults to RAK00N_FILES_ROOT, falling back to /var/rak00n/files.
  function filesPvc(_sessionId: string): {
    volumes: Array<Record<string, unknown>>
    volumeMounts: Array<Record<string, unknown>>
  } {
    const claim = process.env.RAK00N_WORKER_FILES_PVC?.trim()
    if (!claim) return { volumes: [], volumeMounts: [] }
    const mountPath =
      process.env.RAK00N_WORKER_FILES_MOUNT_PATH?.trim() ||
      process.env.RAK00N_FILES_ROOT?.trim() ||
      '/var/rak00n/files'
    return {
      volumes: [
        { name: 'rak00n-files', persistentVolumeClaim: { claimName: claim } },
      ],
      volumeMounts: [
        { name: 'rak00n-files', mountPath, readOnly: false },
      ],
    }
  }

  const jobSpec = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace,
      labels: {
        'app.kubernetes.io/name': 'rak00n',
        'app.kubernetes.io/instance': 'rak00n',
        'app.kubernetes.io/component': 'worker',
        'rak00n.ai/turn-id': turnId.slice(0, 8),
      },
    },
    spec: {
      ttlSecondsAfterFinished: Number(process.env.RAK00N_WORKER_TTL) || 300,
      activeDeadlineSeconds: Number(process.env.RAK00N_WORKER_DEADLINE) || 600,
      backoffLimit: 0,
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/name': 'rak00n',
            'app.kubernetes.io/instance': 'rak00n',
            'app.kubernetes.io/component': 'worker',
            'rak00n.ai/turn-id': turnId.slice(0, 8),
          },
        },
        spec: {
          serviceAccountName: sa,
          restartPolicy: 'Never',
          containers: [{
            name: 'worker',
            image,
            imagePullPolicy: process.env.RAK00N_WORKER_IMAGE_PULL_POLICY || 'IfNotPresent',
            env: [
              { name: 'RAK00N_MODE', value: 'worker' },
              { name: 'RAK00N_WORKER_TURN_ID', value: turnId },
              { name: 'REDIS_URL', value: redisUrl },
              { name: 'ANTHROPIC_FOUNDRY_API_KEY', value: foundryKey },
              { name: 'ANTHROPIC_FOUNDRY_BASE_URL', value: foundryUrl },
              { name: 'NODE_ENV', value: 'production' },
              { name: 'RAK00N_INTERNAL_API_URL', value: internalApiUrl },
              { name: 'RAK00N_INTERNAL_TOKEN', value: bridgeToken },
              { name: 'RAK00N_INTERNAL_TURN_ID', value: turnId },
              { name: 'RAK00N_INTERNAL_SESSION_ID', value: task.sessionId },
              ...(task.knobs?.agentDefinition
                ? [{
                    name: 'RAK00N_AGENT_DEFINITION_JSON',
                    value: JSON.stringify(task.knobs.agentDefinition),
                  }]
                : []),
            ],
            resources: {
              requests: { cpu: '100m', memory: '256Mi' },
              limits: { cpu: '1', memory: '1Gi' },
            },
            ...(filesPvc(task.sessionId).volumeMounts.length > 0
              ? { volumeMounts: filesPvc(task.sessionId).volumeMounts }
              : {}),
          }],
          ...(filesPvc(task.sessionId).volumes.length > 0
            ? { volumes: filesPvc(task.sessionId).volumes }
            : {}),
        },
      },
    },
  }

  // Use Node's built-in fetch with TLS config via custom agent
  // For in-cluster K8s API, we need to trust the cluster CA
  const url = `${apiServer}/apis/batch/v1/namespaces/${namespace}/jobs`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(jobSpec),
    // @ts-ignore - Bun supports tls option
    tls: { ca: caCert },
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`K8s Job creation failed (${res.status}): ${body.slice(0, 300)}`)
  }

  await incrementWorkerCount(store)
  log.info('worker_job_launched', { jobName, turnId, sessionId: task.sessionId })

  // Monitor for completion in background
  monitorWorkerJob(store, task.sessionId, turnId, jobName, namespace, token, caCert, apiServer)

  return { jobName }
}

function monitorWorkerJob(
  store: Store,
  sessionId: string,
  turnId: string,
  jobName: string,
  namespace: string,
  token: string,
  caCert: string,
  apiServer: string,
): void {
  const poll = async () => {
    const maxWait = 600_000
    const start = Date.now()
    while (Date.now() - start < maxWait) {
      await new Promise(r => setTimeout(r, 2000))
      try {
        const res = await fetch(
          `${apiServer}/apis/batch/v1/namespaces/${namespace}/jobs/${jobName}`,
          { headers: { Authorization: `Bearer ${token}` }, tls: { ca: caCert } as any },
        )
        if (!res.ok) continue
        const job = await res.json() as any
        const conditions = job.status?.conditions || []
        const complete = conditions.find((c: any) => c.type === 'Complete' && c.status === 'True')
        const failed = conditions.find((c: any) => c.type === 'Failed' && c.status === 'True')
        if (complete || failed) {
          await decrementWorkerCount(store)
          log.info('worker_job_finished', { jobName, turnId, succeeded: !!complete })
          if (failed) {
            // Surface as an error event so any consumer waiting on
            // subscribeToWorker doesn't hang on the timeout.
            const reason = failed.reason || 'JobFailed'
            const message = failed.message || 'K8s Job failed'
            await publishWorkerEvent(store, sessionId, turnId, {
              type: 'error',
              message: `${reason}: ${message}`,
            }).catch(() => {})
          }
          return
        }
      } catch { /* keep polling */ }
    }
    await decrementWorkerCount(store)
    log.warn('worker_job_monitor_timeout', { jobName, turnId })
    await publishWorkerEvent(store, sessionId, turnId, {
      type: 'error',
      message: `Worker job ${jobName} monitor timed out`,
    }).catch(() => {})
  }
  poll().catch(() => decrementWorkerCount(store).catch(() => {}))
}
