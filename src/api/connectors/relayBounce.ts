/**
 * Where should the OAuth relay bounce the browser back to?
 *
 * The relay only redirects to hosts it trusts (*.device.orb2.app, *.ts.net,
 * localhost). The device.orb2.app name is a public record pointing at a
 * PRIVATE IP — which some routers (AT&T gateways included) silently filter
 * as DNS-rebind protection, making that host unresolvable exactly where
 * it's needed. So we prefer, in order:
 *
 *   1. the host the user's browser is ALREADY on (it demonstrably works),
 *      when the relay would accept it;
 *   2. the tailscale MagicDNS name (resolves on any device with the TS app,
 *      and from anywhere with Funnel on);
 *   3. the device-cert hostname as the last resort (fine on networks
 *      without rebind filtering).
 */
import type { Store } from '../store/store.js'

export function hostAllowedByRelay(hostPort: string): boolean {
  const host = hostPort.split(':')[0]!.toLowerCase()
  return host.endsWith('.device.orb2.app') || host.endsWith('.ts.net') || host === 'localhost' || host === '127.0.0.1'
}

/** Base URL (scheme + host[:port]) the bounce should land on, or null. */
export async function bounceBase(store: Store, req?: Request): Promise<string | null> {
  const rawHost = req?.headers.get('x-forwarded-host') || req?.headers.get('host') || ''
  // nginx's $host strips the port; a portless localhost bounce would land on
  // :80 and die, so localhost only counts when its port survived the proxy.
  const portlessLocal = /^(localhost|127\.0\.0\.1)$/.test(rawHost)
  if (rawHost && !portlessLocal && hostAllowedByRelay(rawHost)) {
    // ts.net / device.orb2.app always serve https (and the relay requires
    // it); the browser's current proto is irrelevant. localhost may be http.
    const isLocal = /^(localhost|127\.0\.0\.1)(:|$)/.test(rawHost)
    const proto = isLocal ? (req?.headers.get('x-forwarded-proto') || 'http') : 'https'
    return `${proto}://${rawHost}`
  }
  try {
    const { tailscaleStatus } = await import('./tailscale.js')
    const st = await tailscaleStatus()
    if (st.running && st.hostname && st.hostname.endsWith('.ts.net')) return `https://${st.hostname}`
    if (st.url) return st.url.replace(/\/+$/, '')
  } catch { /* no tailscale */ }
  const host = await store.getKv('devicecert:hostname').catch(() => null)
  if (!host) return null
  const port = Number(process.env.ORB2_DEVICE_TLS_PORT || 9444)
  return `https://${host}${port === 443 ? '' : `:${port}`}`
}
