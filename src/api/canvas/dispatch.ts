/**
 * Canvas pod lifecycle management.
 *
 * Unlike ephemeral worker Jobs (one per turn), canvas pods are
 * long-lived and session-sticky. Each canvas session gets a dedicated
 * pod that runs:
 *   1. A Vite dev server for live preview (port 5173)
 *   2. An HTTP RPC server that receives agent turns from the router
 *
 * Pod lifecycle:
 *   createCanvasPod  → K8s Pod created, registered in Redis
 *   routeToCanvasPod → Forwards agent turn to the running pod
 *   snapshotAndDestroy → Tars upper layer, uploads, deletes pod
 *
 * Session stickiness is guaranteed by Redis:
 *   orb2:canvas:<sessionId> → JSON(CanvasPodInfo)
 *
 * The pod's idle timeout is enforced by the canvas-worker entrypoint
 * which self-terminates after ORB2_CANVAS_IDLE_TIMEOUT_MS of no
 * incoming turns. The router also runs a periodic cleanup sweep.
 */
import { randomUUID } from 'node:crypto'
import type { Store } from '../store/store.js'
import { log } from '../log.js'
import type { CanvasPodInfo, CanvasSessionConfig, CanvasTemplate } from './types.js'
import { DEFAULT_CANVAS_CONFIG } from './types.js'

const CANVAS_KEY_PREFIX = 'orb2:canvas:'
const CANVAS_POD_TTL = 7200 // 2h Redis key TTL (pod self-terminates sooner)

export function isCanvasModeEnabled(): boolean {
  return process.env.ORB2_CANVAS_ENABLED === '1'
}

export async function getCanvasPod(
  store: Store,
  sessionId: string,
): Promise<CanvasPodInfo | null> {
  const raw = await store.getKv(`${CANVAS_KEY_PREFIX}${sessionId}`)
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

export async function registerCanvasPod(
  store: Store,
  info: CanvasPodInfo,
): Promise<void> {
  await store.putKv(
    `${CANVAS_KEY_PREFIX}${info.sessionId}`,
    JSON.stringify(info),
    CANVAS_POD_TTL,
  )
}

export async function removeCanvasPod(
  store: Store,
  sessionId: string,
): Promise<void> {
  await store.delKv(`${CANVAS_KEY_PREFIX}${sessionId}`)
}

export async function createCanvasPod(
  store: Store,
  sessionId: string,
  config: CanvasSessionConfig = DEFAULT_CANVAS_CONFIG,
): Promise<CanvasPodInfo> {
  const namespace = process.env.ORB2_CANVAS_NAMESPACE || process.env.ORB2_WORKER_NAMESPACE || 'orb2'
  const image = process.env.ORB2_CANVAS_IMAGE || 'orb2-canvas:dev'
  const redisUrl = process.env.REDIS_URL || ''
  const foundryKey = process.env.ANTHROPIC_FOUNDRY_API_KEY || ''
  const foundryUrl = process.env.ANTHROPIC_FOUNDRY_BASE_URL || ''
  const internalApiUrl =
    process.env.ORB2_INTERNAL_API_URL ||
    `http://orb2-api.${namespace}.svc.cluster.local:8080`
  const vitePort = 5173
  const rpcPort = 9090
  const podName = `orb2-canvas-${sessionId.slice(0, 8)}-${randomUUID().slice(0, 4)}`

  const podSpec = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: podName,
      namespace,
      labels: {
        'app.kubernetes.io/name': 'orb2',
        'app.kubernetes.io/instance': 'orb2',
        'app.kubernetes.io/component': 'canvas-worker',
        'orb2.ai/session-id': sessionId.slice(0, 8),
      },
    },
    spec: {
      automountServiceAccountToken: false,
      ...(config.runtimeClassName && { runtimeClassName: config.runtimeClassName }),
      restartPolicy: 'Never',
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 10001,
        runAsGroup: 10001,
        fsGroup: 10001,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      // Share the uploaded-files PVC with the canvas pod so attached
      // files are visible at the same absolute path the chat / worker
      // pods see them at. Without this, the agent inside the canvas
      // pod can read meta.path values from the SYSTEM note but the
      // path itself resolves to ENOENT, and Canvas-with-attachment
      // turns fail while plain chat-about-the-file works.
      ...(process.env.ORB2_WORKER_FILES_PVC?.trim() && {
        volumes: [
          {
            name: 'orb2-files',
            persistentVolumeClaim: {
              claimName: process.env.ORB2_WORKER_FILES_PVC.trim(),
            },
          },
        ],
      }),
      containers: [{
        name: 'canvas',
        image,
        imagePullPolicy: process.env.ORB2_CANVAS_IMAGE_PULL_POLICY || 'IfNotPresent',
        ports: [
          { containerPort: vitePort, name: 'vite' },
          { containerPort: rpcPort, name: 'rpc' },
        ],
        ...(process.env.ORB2_WORKER_FILES_PVC?.trim() && {
          volumeMounts: [
            {
              name: 'orb2-files',
              mountPath:
                process.env.ORB2_WORKER_FILES_MOUNT_PATH?.trim() ||
                process.env.ORB2_FILES_ROOT?.trim() ||
                '/var/orb2/files',
              readOnly: false,
            },
          ],
        }),
        env: [
          { name: 'ORB2_MODE', value: 'canvas' },
          { name: 'ORB2_CANVAS_SESSION_ID', value: sessionId },
          { name: 'ORB2_CANVAS_TEMPLATE', value: config.template },
          { name: 'ORB2_CANVAS_IDLE_TIMEOUT_MS', value: String(config.idleTimeoutMs) },
          { name: 'ORB2_CANVAS_VITE_PORT', value: String(vitePort) },
          { name: 'ORB2_CANVAS_RPC_PORT', value: String(rpcPort) },
          { name: 'REDIS_URL', value: redisUrl },
          { name: 'ANTHROPIC_FOUNDRY_API_KEY', value: foundryKey },
          { name: 'ANTHROPIC_FOUNDRY_BASE_URL', value: foundryUrl },
          { name: 'ORB2_INTERNAL_API_URL', value: internalApiUrl },
          // Pass the files root through so any in-pod code that
          // reads ORB2_FILES_ROOT (e.g. file-meta lookups) resolves
          // to the same path the worker uses.
          ...(process.env.ORB2_FILES_ROOT?.trim()
            ? [{ name: 'ORB2_FILES_ROOT', value: process.env.ORB2_FILES_ROOT.trim() }]
            : []),
        ],
        resources: {
          requests: {
            cpu: config.resourceLimits.cpuRequest,
            memory: config.resourceLimits.memoryRequest,
          },
          limits: {
            cpu: config.resourceLimits.cpuLimit,
            memory: config.resourceLimits.memoryLimit,
          },
        },
        securityContext: {
          allowPrivilegeEscalation: false,
          capabilities: {
            drop: ['ALL'],
            add: ['SYS_ADMIN'], // fuse-overlayfs
          },
        },
        readinessProbe: {
          httpGet: { path: '/healthz', port: rpcPort },
          initialDelaySeconds: 2,
          periodSeconds: 5,
        },
      }],
    },
  }

  const { readFileSync } = await import('node:fs')
  const token = readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf-8').trim()
  const caCert = readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt', 'utf-8')
  const apiServer = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`

  const url = `${apiServer}/api/v1/namespaces/${namespace}/pods`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(podSpec),
    // @ts-ignore - Bun supports tls option
    tls: { ca: caCert },
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Canvas pod creation failed (${res.status}): ${body.slice(0, 300)}`)
  }

  // Wait for the pod to get an IP (poll up to 30s)
  let podIp = ''
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500))
    const statusRes = await fetch(
      `${apiServer}/api/v1/namespaces/${namespace}/pods/${podName}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        // @ts-ignore
        tls: { ca: caCert },
      },
    )
    if (statusRes.ok) {
      const pod = await statusRes.json() as any
      if (pod.status?.podIP) {
        podIp = pod.status.podIP
        break
      }
    }
  }

  if (!podIp) {
    throw new Error(`Canvas pod ${podName} did not receive an IP within 30s`)
  }

  const info: CanvasPodInfo = {
    sessionId,
    podName,
    podIp,
    vitePort,
    rpcPort,
    state: 'running',
    template: config.template,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
  }

  await registerCanvasPod(store, info)
  log.info('canvas_pod_created', { podName, sessionId, podIp, template: config.template })

  return info
}

export async function destroyCanvasPod(
  store: Store,
  sessionId: string,
): Promise<void> {
  const info = await getCanvasPod(store, sessionId)
  if (!info) return

  const namespace = process.env.ORB2_CANVAS_NAMESPACE || process.env.ORB2_WORKER_NAMESPACE || 'orb2'
  const { readFileSync } = await import('node:fs')
  const token = readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf-8').trim()
  const caCert = readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt', 'utf-8')
  const apiServer = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`

  const url = `${apiServer}/api/v1/namespaces/${namespace}/pods/${info.podName}`
  await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
    // @ts-ignore
    tls: { ca: caCert },
  }).catch(err => log.warn('canvas_pod_delete_failed', { error: (err as Error).message }))

  await removeCanvasPod(store, sessionId)
  log.info('canvas_pod_destroyed', { podName: info.podName, sessionId })
}

/**
 * Forward an agent turn to the canvas pod's RPC endpoint.
 * Returns the agent result. The canvas pod runs the turn in-process
 * so the working directory is the same one Vite watches.
 */
export async function routeToCanvasPod(
  info: CanvasPodInfo,
  body: {
    message: string
    model?: string
    previousMessages?: unknown[]
    mcpToken?: string
    sessionId: string
    fallbackModels?: string[]
    [key: string]: unknown
  },
): Promise<{
  fullText: string
  promptTokens: number
  completionTokens: number
  finalMessages: unknown[]
}> {
  const url = `http://${info.podIp}:${info.rpcPort}/turn`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Canvas pod RPC failed (${res.status}): ${errText.slice(0, 300)}`)
  }

  return await res.json() as any
}
