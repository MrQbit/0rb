/**
 * In-cluster Kubernetes REST client.
 *
 * Reuses the same in-cluster ServiceAccount credential mechanism as
 * workerDispatch.ts (token + CA cert mounted by k8s). Exposes a small
 * set of STRUCTURED operations rather than arbitrary kubectl — the
 * agent gets cluster control without an injection surface for shelling
 * out raw commands.
 *
 * All operations are scoped to the agent's own namespace unless an
 * explicit namespace is passed (RBAC still gates what's permitted).
 */
import { readFileSync, existsSync } from 'node:fs'

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount'

export function isInCluster(): boolean {
  return (
    existsSync(`${SA_DIR}/token`) &&
    !!process.env.KUBERNETES_SERVICE_HOST
  )
}

function creds(): { token: string; caCert: string; apiServer: string; namespace: string } {
  const token = readFileSync(`${SA_DIR}/token`, 'utf-8').trim()
  const caCert = readFileSync(`${SA_DIR}/ca.crt`, 'utf-8')
  const apiServer = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`
  const namespace =
    process.env.RAK00N_WORKER_NAMESPACE ||
    (existsSync(`${SA_DIR}/namespace`) ? readFileSync(`${SA_DIR}/namespace`, 'utf-8').trim() : 'rak00n')
  return { token, caCert, apiServer, namespace }
}

async function k8sRequest(
  method: string,
  path: string,
  body?: unknown,
  contentType = 'application/json',
): Promise<any> {
  const { token, caCert, apiServer } = creds()
  const res = await fetch(`${apiServer}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': contentType,
      Accept: 'application/json',
    },
    body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    tls: { ca: caCert },
  })
  const text = await res.text()
  let parsed: any
  try { parsed = text ? JSON.parse(text) : {} } catch { parsed = { raw: text } }
  if (!res.ok) {
    throw new Error(`k8s ${method} ${path} → ${res.status}: ${parsed.message || text.slice(0, 300)}`)
  }
  return parsed
}

export function currentNamespace(): string {
  return creds().namespace
}

export async function listPods(ns?: string): Promise<Array<{ name: string; phase: string; ready: boolean; node: string | null }>> {
  const namespace = ns || currentNamespace()
  const data = await k8sRequest('GET', `/api/v1/namespaces/${namespace}/pods`)
  return (data.items || []).map((p: any) => ({
    name: p.metadata?.name,
    phase: p.status?.phase,
    ready: (p.status?.containerStatuses || []).every((c: any) => c.ready),
    node: p.spec?.nodeName || null,
  }))
}

export async function listJobs(ns?: string): Promise<Array<{ name: string; active: number; succeeded: number; failed: number }>> {
  const namespace = ns || currentNamespace()
  const data = await k8sRequest('GET', `/apis/batch/v1/namespaces/${namespace}/jobs`)
  return (data.items || []).map((j: any) => ({
    name: j.metadata?.name,
    active: j.status?.active || 0,
    succeeded: j.status?.succeeded || 0,
    failed: j.status?.failed || 0,
  }))
}

export async function listDeployments(ns?: string): Promise<Array<{ name: string; replicas: number; ready: number; image: string | null }>> {
  const namespace = ns || currentNamespace()
  const data = await k8sRequest('GET', `/apis/apps/v1/namespaces/${namespace}/deployments`)
  return (data.items || []).map((d: any) => ({
    name: d.metadata?.name,
    replicas: d.spec?.replicas || 0,
    ready: d.status?.readyReplicas || 0,
    image: d.spec?.template?.spec?.containers?.[0]?.image || null,
  }))
}

export async function getPodLogs(name: string, opts?: { ns?: string; tailLines?: number; container?: string }): Promise<string> {
  const namespace = opts?.ns || currentNamespace()
  const tail = opts?.tailLines ?? 200
  const q = new URLSearchParams({ tailLines: String(tail) })
  if (opts?.container) q.set('container', opts.container)
  const { token, caCert, apiServer } = creds()
  const res = await fetch(`${apiServer}/api/v1/namespaces/${namespace}/pods/${name}/log?${q}`, {
    headers: { Authorization: `Bearer ${token}` },
    tls: { ca: caCert },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`k8s logs ${name} → ${res.status}: ${text.slice(0, 200)}`)
  return text
}

export async function deletePod(name: string, ns?: string): Promise<void> {
  const namespace = ns || currentNamespace()
  await k8sRequest('DELETE', `/api/v1/namespaces/${namespace}/pods/${name}`)
}

export async function deleteJob(name: string, ns?: string): Promise<void> {
  const namespace = ns || currentNamespace()
  await k8sRequest('DELETE', `/apis/batch/v1/namespaces/${namespace}/jobs/${name}?propagationPolicy=Background`)
}

export async function scaleDeployment(name: string, replicas: number, ns?: string): Promise<void> {
  const namespace = ns || currentNamespace()
  await k8sRequest(
    'PATCH',
    `/apis/apps/v1/namespaces/${namespace}/deployments/${name}/scale`,
    { spec: { replicas } },
    'application/merge-patch+json',
  )
}

export async function patchDeploymentImage(name: string, image: string, container: string, ns?: string): Promise<void> {
  const namespace = ns || currentNamespace()
  await k8sRequest(
    'PATCH',
    `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`,
    { spec: { template: { spec: { containers: [{ name: container, image }] } } } },
    'application/strategic-merge-patch+json',
  )
}

export async function getRolloutStatus(name: string, ns?: string): Promise<{ replicas: number; ready: number; updated: number; available: number }> {
  const namespace = ns || currentNamespace()
  const d = await k8sRequest('GET', `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`)
  return {
    replicas: d.spec?.replicas || 0,
    ready: d.status?.readyReplicas || 0,
    updated: d.status?.updatedReplicas || 0,
    available: d.status?.availableReplicas || 0,
  }
}
