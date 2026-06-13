/**
 * mDNS / DNS-SD advertisement — lets the 0rb Control Panel (and any LAN client)
 * discover the server without typing an IP. We advertise `_0rb._tcp` with the
 * API port and a couple of TXT hints; the panel browses for it (avahi-browse
 * _0rb._tcp) and opens the console fullscreen.
 *
 * Off with ORB2_MDNS=0. Best-effort — never blocks or crashes boot.
 */
import { log } from '../log.js'

let bonjour: any = null
let service: any = null

/** Begin advertising the 0rb server on the LAN. Idempotent. */
export function advertiseOrb(port: number): void {
  if (service || process.env.ORB2_MDNS === '0') return
  try {
    // Lazy import so a build/runtime without the dep simply skips advertising.
    const { Bonjour } = require('bonjour-service') as typeof import('bonjour-service')
    bonjour = new Bonjour()
    service = bonjour.publish({
      name: process.env.ORB2_MDNS_NAME || '0rb',
      type: '0rb',            // advertised as _0rb._tcp
      protocol: 'tcp',
      port,
      txt: {
        path: '/',
        version: process.env.ORB2_API_VERSION || 'dev',
      },
    })
    log.info('mdns_advertised', { service: '_0rb._tcp', name: process.env.ORB2_MDNS_NAME || '0rb', port })
  } catch (err) {
    log.warn('mdns_advertise_failed', { error: (err as Error).message })
  }
}

/** Stop advertising (graceful shutdown). */
export function stopAdvertise(): void {
  try { service?.stop?.() } catch { /* ignore */ }
  try { bonjour?.destroy?.() } catch { /* ignore */ }
  service = null
  bonjour = null
}
