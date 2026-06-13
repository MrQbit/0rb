/**
 * Operator tool executors: ClusterOps (k8s), DockerOps (host docker),
 * and SelfUpdate (blue-green deployment image patch + rollout watch).
 *
 * These are the executor bodies; tool definitions and agent wiring live
 * in src/api/tools/apiNativeTools.ts. REST endpoints live in routes.ts.
 */
import * as k8s from './k8sClient.js'
import * as docker from './dockerClient.js'

// ─────────────────────── ClusterOps ───────────────────────

export type ClusterOpsInput = {
  op:
    | 'list_pods'
    | 'list_jobs'
    | 'list_deployments'
    | 'pod_logs'
    | 'delete_pod'
    | 'delete_job'
    | 'scale'
    | 'rollout_status'
  name?: string
  namespace?: string
  replicas?: number
  tail_lines?: number
}

export async function executeClusterOps(input: ClusterOpsInput): Promise<string> {
  if (!k8s.isInCluster()) {
    return 'ClusterOps unavailable: not running inside a Kubernetes cluster.'
  }
  switch (input.op) {
    case 'list_pods':
      return JSON.stringify(await k8s.listPods(input.namespace), null, 2)
    case 'list_jobs':
      return JSON.stringify(await k8s.listJobs(input.namespace), null, 2)
    case 'list_deployments':
      return JSON.stringify(await k8s.listDeployments(input.namespace), null, 2)
    case 'pod_logs':
      if (!input.name) throw new Error('pod_logs requires "name"')
      return await k8s.getPodLogs(input.name, { ns: input.namespace, tailLines: input.tail_lines })
    case 'delete_pod':
      if (!input.name) throw new Error('delete_pod requires "name"')
      await k8s.deletePod(input.name, input.namespace)
      return `Pod ${input.name} deleted.`
    case 'delete_job':
      if (!input.name) throw new Error('delete_job requires "name"')
      await k8s.deleteJob(input.name, input.namespace)
      return `Job ${input.name} deleted.`
    case 'scale':
      if (!input.name || typeof input.replicas !== 'number') throw new Error('scale requires "name" and "replicas"')
      await k8s.scaleDeployment(input.name, input.replicas, input.namespace)
      return `Deployment ${input.name} scaled to ${input.replicas} replicas.`
    case 'rollout_status':
      if (!input.name) throw new Error('rollout_status requires "name"')
      return JSON.stringify(await k8s.getRolloutStatus(input.name, input.namespace), null, 2)
    default:
      throw new Error(`Unknown ClusterOps op: ${(input as any).op}`)
  }
}

// ─────────────────────── DockerOps ───────────────────────

export type DockerOpsInput = {
  op: 'list' | 'logs' | 'restart' | 'stop' | 'start'
  container?: string
  tail_lines?: number
}

export async function executeDockerOps(input: DockerOpsInput): Promise<string> {
  if (!docker.isDockerOpsEnabled()) {
    return 'DockerOps disabled. Set ORB2_DOCKER_OPS_ENABLED=1 and mount /var/run/docker.sock to enable host docker control.'
  }
  switch (input.op) {
    case 'list':
      return JSON.stringify(await docker.listContainers(), null, 2)
    case 'logs':
      if (!input.container) throw new Error('logs requires "container"')
      return await docker.containerLogs(input.container, input.tail_lines)
    case 'restart':
      if (!input.container) throw new Error('restart requires "container"')
      await docker.restartContainer(input.container)
      return `Container ${input.container} restarted.`
    case 'stop':
      if (!input.container) throw new Error('stop requires "container"')
      await docker.stopContainer(input.container)
      return `Container ${input.container} stopped.`
    case 'start':
      if (!input.container) throw new Error('start requires "container"')
      await docker.startContainer(input.container)
      return `Container ${input.container} started.`
    default:
      throw new Error(`Unknown DockerOps op: ${(input as any).op}`)
  }
}

// ─────────────────────── SelfUpdate ───────────────────────

export type SelfUpdateInput = {
  image: string
  deployment?: string
  container?: string
  timeout_s?: number
}

/**
 * Blue-green self-update: patch the Deployment's image and watch the
 * rolling update to completion. With 2+ replicas and maxUnavailable=0,
 * the new pod must pass readiness before the old one is removed, so the
 * agent stays reachable throughout. The agent is expected to have
 * already built + imported the new image (via Bash/sandbox) before
 * calling this.
 */
export async function executeSelfUpdate(input: SelfUpdateInput): Promise<string> {
  if (!k8s.isInCluster()) {
    return 'SelfUpdate unavailable: not running inside a Kubernetes cluster.'
  }
  const deployment = input.deployment || process.env.ORB2_SELF_DEPLOYMENT || 'orb2-api'
  const container = input.container || 'orb2-api'
  const timeoutMs = (input.timeout_s ?? 180) * 1000

  await k8s.patchDeploymentImage(deployment, input.image, container)

  const start = Date.now()
  let last = { replicas: 0, ready: 0, updated: 0, available: 0 }
  while (Date.now() - start < timeoutMs) {
    last = await k8s.getRolloutStatus(deployment)
    // Rollout complete when all desired replicas are updated AND ready.
    if (last.replicas > 0 && last.updated >= last.replicas && last.ready >= last.replicas) {
      return `SelfUpdate complete: ${deployment} now running ${input.image} (${last.ready}/${last.replicas} ready).`
    }
    await new Promise(r => setTimeout(r, 3000))
  }
  return `SelfUpdate timed out after ${input.timeout_s ?? 180}s. Last status: ${JSON.stringify(last)}. The rollout may still be in progress; check ClusterOps rollout_status.`
}

// ─────────────────────── SelfBuild ───────────────────────

export type SelfBuildInput = {
  /** Image tag to build; defaults to a timestamped tag. */
  tag?: string
  /** Build + import only; skip patching the running Deployment. */
  build_only?: boolean
  /** Rollout timeout passed through to SelfUpdate. */
  timeout_s?: number
}

/**
 * Full self-update build loop: build a new image from the agent's own
 * source, import it into the k3d cluster, then (unless build_only) patch
 * the Deployment to it and watch the blue-green rollout.
 *
 * The build runs on the host via scripts/self-build.sh, which needs host
 * docker (ORB2_DOCKER_OPS_ENABLED=1 + mounted socket) and the k3d CLI.
 * The agent is expected to have edited + tested its source (via Bash/
 * sandbox) BEFORE calling this.
 */
export async function executeSelfBuild(input: SelfBuildInput): Promise<string> {
  if (!k8s.isInCluster()) {
    return 'SelfBuild unavailable: not running inside a Kubernetes cluster.'
  }
  if (!docker.isDockerOpsEnabled()) {
    return 'SelfBuild requires host docker. Set ORB2_DOCKER_OPS_ENABLED=1 and mount /var/run/docker.sock.'
  }
  const tag = input.tag || `selfupdate-${Date.now()}`
  const script = process.env.ORB2_SELF_BUILD_SCRIPT || 'scripts/self-build.sh'

  const proc = Bun.spawn(['bash', script, tag], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: process.env.ORB2_SELF_BUILD_CONTEXT || process.cwd(),
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  if (code !== 0) {
    return `SelfBuild failed (exit ${code}):\n${(stderr || stdout).slice(-1500)}`
  }

  // The script prints `IMAGE=<repo>:<tag>` on success.
  const m = /IMAGE=(\S+)/.exec(stdout)
  const image = m?.[1] || `${process.env.ORB2_SELF_IMAGE_REPO || 'orb2-api'}:${tag}`

  if (input.build_only) {
    return `SelfBuild complete: built + imported ${image}. Call SelfUpdate with this image to roll it out.`
  }
  const rollout = await executeSelfUpdate({ image, timeout_s: input.timeout_s })
  return `Built + imported ${image}.\n${rollout}`
}
