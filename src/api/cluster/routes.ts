/**
 * Cluster/operator REST endpoints. Thin HTTP wrappers over the operator
 * executors so the UI and external callers can drive cluster control
 * without going through a chat turn.
 *
 *   GET  /v1/cluster/status              → pods + deployments snapshot
 *   POST /v1/cluster/ops                 → ClusterOps {op, ...}
 *   POST /v1/cluster/docker              → DockerOps {op, ...}
 *   POST /v1/cluster/self-update         → SelfUpdate {image, ...}
 */
import { executeClusterOps, executeDockerOps, executeSelfUpdate } from './operators.js'
import { isInCluster, listPods, listDeployments } from './k8sClient.js'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function readJson(req: Request): Promise<any> {
  try { return await req.json() } catch { return {} }
}

export async function tryHandleClusterRoute(method: string, pathname: string, req: Request): Promise<Response | null> {
  if (!pathname.startsWith('/v1/cluster')) return null

  if (method === 'GET' && pathname === '/v1/cluster/status') {
    if (!isInCluster()) {
      return jsonResponse(200, { in_cluster: false, pods: [], deployments: [] })
    }
    try {
      const [pods, deployments] = await Promise.all([listPods(), listDeployments()])
      return jsonResponse(200, { in_cluster: true, pods, deployments })
    } catch (err) {
      return jsonResponse(500, { error: (err as Error).message })
    }
  }

  if (method === 'POST' && pathname === '/v1/cluster/ops') {
    const body = await readJson(req)
    try {
      return jsonResponse(200, { result: await executeClusterOps(body) })
    } catch (err) {
      return jsonResponse(400, { error: (err as Error).message })
    }
  }

  if (method === 'POST' && pathname === '/v1/cluster/docker') {
    const body = await readJson(req)
    try {
      return jsonResponse(200, { result: await executeDockerOps(body) })
    } catch (err) {
      return jsonResponse(400, { error: (err as Error).message })
    }
  }

  if (method === 'POST' && pathname === '/v1/cluster/self-update') {
    const body = await readJson(req)
    if (!body.image) return jsonResponse(400, { error: 'image is required' })
    try {
      return jsonResponse(200, { result: await executeSelfUpdate(body) })
    } catch (err) {
      return jsonResponse(400, { error: (err as Error).message })
    }
  }

  return null
}
