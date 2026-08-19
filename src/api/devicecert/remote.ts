/**
 * Remote reachability for the device hostname — the user's choice of two
 * honest mechanisms:
 *
 *   'lan'    (default) — A record = LAN IP. Zero-warning HTTPS at home;
 *            away-from-home rides Tailscale (tailnet or Funnel).
 *   'direct' — DynDNS: the A record follows the house's WAN IP (refreshed
 *            outbound on a schedule — nothing inbound needed to stay fresh),
 *            and the router forwards TCP 9444 to this box: opened via UPnP
 *            when the router speaks it, otherwise we detect the router brand
 *            and give exact manual steps. The relay then probes the URL from
 *            the internet so the status is verified, not assumed.
 */
import type { Store } from '../store/store.js'
import { log } from '../log.js'

export type RemoteMode = 'lan' | 'direct'
const MODE_KEY = 'remote:mode'
const REFRESH_MS = 10 * 60 * 1000
const TLS_PORT = Number(process.env.ORB2_DEVICE_TLS_PORT || 9444)

function relayBase(): string {
  return (process.env.ORB2_BROKER_URL || '').replace(/\/+$/, '')
}

async function identity(store: Store): Promise<{ device_id: string; token: string; hostname: string } | null> {
  const device_id = await store.getKv('devicecert:device_id')
  const token = await store.getKv('devicecert:token')
  const hostname = await store.getKv('devicecert:hostname')
  return device_id && token && hostname ? { device_id, token, hostname } : null
}

export async function getRemoteMode(store: Store): Promise<RemoteMode> {
  return ((await store.getKv(MODE_KEY)) as RemoteMode) || 'lan'
}

/** The house's public IP, asked outbound (the DynDNS half). */
export async function wanIp(): Promise<string | null> {
  try {
    const r = await fetch(`${relayBase()}/api/device/ip`, { signal: AbortSignal.timeout(6000) })
    const j: any = await r.json()
    return typeof j.ip === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(j.ip) ? j.ip : null
  } catch { return null }
}

/** Ask the relay to hit our public URL FROM the internet — ground truth. */
export async function probeFromInternet(store: Store): Promise<{ ok: boolean; status?: number; error?: string } | null> {
  const id = await identity(store)
  if (!id) return null
  try {
    const r = await fetch(`${relayBase()}/api/device/probe`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_id: id.device_id, token: id.token, port: TLS_PORT }),
      signal: AbortSignal.timeout(10_000),
    })
    return await r.json() as any
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

/** Best-effort router identification for the manual-forwarding assistant. */
export async function routerHint(): Promise<{ gateway?: string; brand?: string; steps?: string }> {
  for (const gw of ['192.168.1.254', '192.168.1.1', '192.168.0.1', '10.0.0.1']) {
    try {
      const r = await fetch(`http://${gw}/`, { redirect: 'manual', signal: AbortSignal.timeout(1500) })
      const loc = r.headers.get('location') || ''
      if (r.status === 0) continue
      if (/\.ha\b/.test(loc) || gw === '192.168.1.254') {
        return {
          gateway: gw, brand: 'AT&T gateway (BGW series — no UPnP)',
          steps: `Open http://${gw} → Firewall → NAT/Gaming → Custom Services: add "orb2" TCP ${TLS_PORT}→${TLS_PORT}, then assign it to this device (${process.env.ORB2_DEVICE_LAN_IP || 'the orb'}). The gateway asks for the Device Access Code printed on its label.`,
        }
      }
      return { gateway: gw, brand: 'router', steps: `Open http://${gw} and forward TCP ${TLS_PORT} to ${process.env.ORB2_DEVICE_LAN_IP || 'this device'} (often under Port Forwarding / NAT).` }
    } catch { /* next candidate */ }
  }
  return {}
}

/** Apply the current mode: point the A record at the right address, keep the
 *  router mapping alive (direct), and report verified status. */
export async function applyRemote(store: Store): Promise<any> {
  const { setA, detectLanIp, deviceCertEnabled } = await import('./broker.js')
  if (!deviceCertEnabled()) return { enabled: false }
  const id = await identity(store)
  if (!id) return { enabled: false, error: 'device not registered yet' }
  const mode = await getRemoteMode(store)
  const lan = (process.env.ORB2_DEVICE_LAN_IP || '').trim() || detectLanIp() || ''

  if (mode === 'lan') {
    if (lan) await setA(id as any, lan).catch(() => { /* best effort */ })
    return { enabled: true, mode, hostname: id.hostname, a_record: lan }
  }

  // direct: A record follows the WAN IP; refresh only on change.
  const out: any = { enabled: true, mode, hostname: id.hostname }
  const ip = await wanIp()
  if (!ip) { out.error = 'could not determine the public IP'; return out }
  out.wan_ip = ip
  const last = await store.getKv('remote:last_wan')
  if (ip !== last) {
    await setA(id as any, ip)
    await store.putKv('remote:last_wan', ip, 0)
    log.info('remote_dyndns_update', { ip })
  }
  out.a_record = ip

  // Router: try UPnP through the bridge; fall back to brand-specific steps.
  try {
    const { bridgeEnabled, bridgeUpnpMap } = await import('../connectors/bridge.js')
    if (bridgeEnabled()) {
      const map = await bridgeUpnpMap(TLS_PORT, lan || undefined)
      out.upnp = map
      if (!map.ok) out.router = await routerHint()
    } else out.router = await routerHint()
  } catch (e) {
    out.upnp = { ok: false, error: (e as Error).message }
    out.router = await routerHint()
  }

  out.probe = await probeFromInternet(store)
  return out
}

export async function setRemoteMode(store: Store, mode: RemoteMode): Promise<any> {
  await store.putKv(MODE_KEY, mode, 0)
  return applyRemote(store)
}

let started = false
export function startRemoteRefresh(store: Store): void {
  if (started) return
  started = true
  // Quiet keep-fresh: in direct mode the WAN IP can change under us; an
  // outbound check every 10 minutes keeps the record honest.
  setInterval(() => {
    getRemoteMode(store).then(m => { if (m === 'direct') applyRemote(store).catch(() => { /* logged inside */ }) })
  }, REFRESH_MS)
}
