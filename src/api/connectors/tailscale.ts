/**
 * Tailscale control for the Access panel. Drives the HOST tailscaled through
 * its socket (mounted into this container — it's world-rw, so no root needed)
 * using the host's `tailscale` CLI (also mounted). The host install is the
 * source of truth; we only READ status, and run up/serve/down on explicit
 * user action. An already-connected node (e.g. the owner's) is never touched
 * unless they click Disconnect.
 */
import { log } from '../log.js'

const TS_BIN = process.env.ORB2_TAILSCALE_BIN || 'tailscale'
/** The plain-HTTP port `tailscale serve` should proxy to (the UI). */
function serveTarget(): string {
  return process.env.ORB2_TS_SERVE_TARGET || 'http://127.0.0.1:9080'
}

/** Disabled only if explicitly turned off; otherwise we probe the CLI. */
export function tailscaleConfigured(): boolean {
  return process.env.ORB2_TAILSCALE_ENABLED !== '0'
}

async function run(args: string[], timeoutMs = 30000): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const p = Bun.spawn([TS_BIN, ...args], { stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => { try { p.kill() } catch { /* ignore */ } }, timeoutMs)
    const out = await new Response(p.stdout).text()
    const err = await new Response(p.stderr).text()
    await p.exited
    clearTimeout(timer)
    return { ok: p.exitCode === 0, out, err }
  } catch (e) {
    return { ok: false, out: '', err: (e as Error).message }
  }
}

export interface TsStatus {
  available: boolean   // CLI + socket reachable at all
  running: boolean     // tailscaled BackendState === Running
  serving: boolean     // `tailscale serve` is proxying the UI
  hostname?: string
  url?: string         // https://<magicdns> when up
  tailnet?: string
  account?: string
}

export async function tailscaleStatus(): Promise<TsStatus> {
  const r = await run(['status', '--json'], 8000)
  if (!r.ok) return { available: false, running: false, serving: false }
  let j: any = {}
  try { j = JSON.parse(r.out) } catch { return { available: true, running: false, serving: false } }
  const dns = String(j?.Self?.DNSName || '').replace(/\.$/, '')
  const s = await run(['serve', 'status'], 8000)
  const serving = s.ok && /proxy\s+http/i.test(s.out)
  return {
    available: true,
    running: j?.BackendState === 'Running',
    serving,
    hostname: j?.Self?.HostName,
    url: dns ? `https://${dns}` : undefined,
    tailnet: j?.CurrentTailnet?.Name,
    account: j?.User?.[String(j?.Self?.UserID)]?.LoginName,
  }
}

export async function tailscaleUp(authKey: string, hostname?: string): Promise<{ ok: boolean; message: string; status?: TsStatus }> {
  const args = ['up']
  if (authKey) args.push(`--authkey=${authKey}`)
  if (hostname) args.push(`--hostname=${hostname}`)
  const r = await run(args, 60000)
  if (!r.ok) return { ok: false, message: r.err.trim() || r.out.trim() || 'tailscale up failed' }
  // Expose the UI over the tailnet via HTTPS (MagicDNS + auto TLS).
  const s = await run(['serve', '--bg', '--https=443', serveTarget()], 30000)
  if (!s.ok) {
    log.warn('tailscale_serve_failed', { err: s.err })
    return { ok: false, message: `Connected, but exposing the UI failed: ${s.err.trim() || s.out.trim()}` }
  }
  const status = await tailscaleStatus()
  return { ok: true, message: status.url ? `Connected — ${status.url}` : 'Connected', status }
}

/**
 * Free, zero-infra HTTPS for self-hosters. If this box is already on a tailnet,
 * make sure the UI is exposed over HTTPS at https://<node>.<tailnet>.ts.net —
 * Tailscale provisions and renews a real Let's Encrypt cert and terminates TLS,
 * proxying to the local HTTP server. That gives a valid, warning-free secure
 * context (browser mic/camera work) on the LAN and anywhere on the tailnet,
 * with no orb2.app infrastructure.
 *
 * Best-effort and idempotent: no-op if Tailscale isn't running or serve is
 * already active. Never changes the node's connection (no up/down). Additive
 * only. Opt out with ORB2_TS_AUTO_HTTPS=0.
 */
export async function ensureTailscaleHttps(target?: string): Promise<{ ok: boolean; url?: string; message: string }> {
  if (process.env.ORB2_TS_AUTO_HTTPS === '0') return { ok: false, message: 'disabled' }
  const status = await tailscaleStatus()
  if (!status.available || !status.running) return { ok: false, message: 'tailscale not running' }
  if (status.serving) return { ok: true, url: status.url, message: 'already serving' }
  const r = await run(['serve', '--bg', '--https=443', target || serveTarget()], 30000)
  if (!r.ok) {
    log.warn('tailscale_auto_https_failed', { err: r.err.trim() || r.out.trim() })
    return { ok: false, message: r.err.trim() || r.out.trim() || 'serve failed' }
  }
  const after = await tailscaleStatus()
  log.info('tailscale_auto_https', { url: after.url })
  return { ok: true, url: after.url, message: after.url ? `HTTPS at ${after.url}` : 'HTTPS enabled' }
}

export async function tailscaleDown(): Promise<{ ok: boolean; message: string }> {
  await run(['serve', 'reset'], 15000)
  const r = await run(['down'], 15000)
  return { ok: r.ok, message: r.ok ? 'Disconnected from Tailscale.' : (r.err.trim() || 'tailscale down failed') }
}
