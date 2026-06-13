/**
 * Docker host control via the `docker` CLI.
 *
 * Gated behind ORB2_DOCKER_OPS_ENABLED=1 because it requires the host
 * docker socket (/var/run/docker.sock) to be mounted into the pod —
 * that grants effective root on the Spark host, so it's opt-in.
 *
 * Operations are STRUCTURED (list/logs/restart/stop/start) rather than
 * arbitrary `docker` passthrough.
 */

export function isDockerOpsEnabled(): boolean {
  return process.env.ORB2_DOCKER_OPS_ENABLED === '1'
}

async function docker(args: string[], timeoutMs = 15_000): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(['docker', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => { try { proc.kill() } catch { /* ignore */ } }, timeoutMs)
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  clearTimeout(timer)
  return { stdout, stderr, code }
}

export async function listContainers(): Promise<Array<{ id: string; image: string; name: string; status: string }>> {
  const { stdout, code, stderr } = await docker(['ps', '-a', '--format', '{{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Status}}'])
  if (code !== 0) throw new Error(`docker ps failed: ${stderr.slice(0, 200)}`)
  return stdout.trim().split('\n').filter(Boolean).map(line => {
    const [id, image, name, status] = line.split('\t')
    return { id: id!, image: image!, name: name!, status: status! }
  })
}

export async function containerLogs(nameOrId: string, tail = 200): Promise<string> {
  const { stdout, stderr, code } = await docker(['logs', '--tail', String(tail), nameOrId])
  if (code !== 0) throw new Error(`docker logs failed: ${stderr.slice(0, 200)}`)
  return stdout + (stderr ? `\n[stderr]\n${stderr}` : '')
}

export async function restartContainer(nameOrId: string): Promise<void> {
  const { code, stderr } = await docker(['restart', nameOrId])
  if (code !== 0) throw new Error(`docker restart failed: ${stderr.slice(0, 200)}`)
}

export async function stopContainer(nameOrId: string): Promise<void> {
  const { code, stderr } = await docker(['stop', nameOrId])
  if (code !== 0) throw new Error(`docker stop failed: ${stderr.slice(0, 200)}`)
}

export async function startContainer(nameOrId: string): Promise<void> {
  const { code, stderr } = await docker(['start', nameOrId])
  if (code !== 0) throw new Error(`docker start failed: ${stderr.slice(0, 200)}`)
}
