/**
 * Docker control — the api container already has the docker CLI + the host
 * socket mounted (ORB2_DOCKER_OPS_ENABLED), so this just shells out. Powers the
 * Docker widget: both the user (widget buttons) and the agent (Docker tool) can
 * list containers and stop/start/restart them or pull images.
 */
import { execFile } from 'node:child_process'

export function dockerEnabled(): boolean {
  return process.env.ORB2_DOCKER_OPS_ENABLED === '1' || process.env.ORB2_DOCKER_OPS_ENABLED === 'true'
}

function run(args: string[], timeoutMs = 30000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise(resolve => {
    execFile('docker', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (e, stdout, stderr) =>
      resolve({ ok: !e, out: stdout || '', err: stderr || (e ? String(e) : '') }))
  })
}

export interface DockerContainer {
  id: string; name: string; image: string; state: string; status: string
  cpu?: string; mem?: string
}

export async function dockerList(all = true): Promise<DockerContainer[]> {
  const ps = await run(['ps', all ? '-a' : '', '--format', '{{json .}}'].filter(Boolean))
  if (!ps.ok) return []
  const rows = ps.out.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) as any[]
  // live cpu/mem for running containers (one no-stream snapshot)
  const stats = await run(['stats', '--no-stream', '--format', '{{json .}}'])
  const byName = new Map<string, any>()
  if (stats.ok) for (const l of stats.out.split('\n').filter(Boolean)) { try { const s = JSON.parse(l); byName.set(s.Name, s) } catch {} }
  return rows.map(r => {
    const s = byName.get(r.Names)
    return {
      id: (r.ID || '').slice(0, 12), name: r.Names || '', image: r.Image || '',
      state: (r.State || '').toLowerCase(), status: r.Status || '',
      cpu: s?.CPUPerc, mem: s?.MemPerc ? `${s.MemPerc}` : s?.MemUsage,
    }
  })
}

export async function dockerControl(action: string, target?: string, image?: string): Promise<{ ok: boolean; message: string }> {
  switch (action) {
    case 'stop': case 'start': case 'restart': {
      if (!target) return { ok: false, message: 'no container specified' }
      const r = await run([action, target], 60000)
      return { ok: r.ok, message: r.ok ? `${action}ed ${target}` : (r.err || 'failed').slice(-300) }
    }
    case 'pull': {
      if (!image) return { ok: false, message: 'no image specified' }
      const r = await run(['pull', image], 300000)
      return { ok: r.ok, message: r.ok ? `pulled ${image}` : (r.err || 'failed').slice(-300) }
    }
    case 'logs': {
      if (!target) return { ok: false, message: 'no container' }
      const r = await run(['logs', '--tail', '60', target], 15000)
      return { ok: r.ok, message: (r.out || r.err || '').slice(-2000) }
    }
    default: return { ok: false, message: `unknown action ${action}` }
  }
}
