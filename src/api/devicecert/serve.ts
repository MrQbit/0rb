/**
 * Overlay helper for the commercial build: bring up an HTTPS listener using
 * this box's per-device cert (obtained from the central orb2.app broker via
 * DNS-01). Reuses the HTTP server's handlers, so the same app is served over
 * TLS at https://<id>.device.orb2.app. Renews daily and hot-reloads the cert.
 *
 * Wire it in `src/api/server.ts`, right after the HTTP `Bun.serve(serveOpts)`:
 *
 *     void (await import('./devicecert/serve.js')).startDeviceTls(serveOpts, store)
 *
 * No-op unless ORB2_DEVICE_DOMAIN / ORB2_BROKER_URL / ORB2_ENROLL_SECRET are set.
 */
import type { Store } from '../store/store.js'
import { log } from '../log.js'

export async function startDeviceTls(serveOpts: any, store: Store): Promise<void> {
  try {
    const { ensureDeviceCert } = await import('./index.js')
    const cert = await ensureDeviceCert(store)
    if (!cert) return
    const Bun = (globalThis as any).Bun
    const tlsPort = Number(process.env.ORB2_TLS_PORT || 9443)
    const opts = () => ({ ...serveOpts, port: tlsPort, tls: { cert: cert.cert, key: cert.key } })
    const tlsServer = Bun.serve(opts())
    log.info('api_listening_https', { hostname: cert.hostname, port: tlsPort })
    // Daily renewal check; hot-reload the cert if it changed.
    setInterval(async () => {
      try {
        const fresh = await ensureDeviceCert(store)
        if (fresh && fresh.cert !== cert.cert) {
          cert.cert = fresh.cert
          cert.key = fresh.key
          tlsServer.reload(opts() as any)
          log.info('devicecert_reloaded', { hostname: cert.hostname })
        }
      } catch { /* ignore */ }
    }, 24 * 60 * 60 * 1000).unref?.()
  } catch (err) {
    log.warn('device_tls_failed', { error: (err as Error).message })
  }
}
