/**
 * Device certificate — gives this box a real HTTPS cert at
 * `<id>.device.orb2.app` so the browser/app connect over the LAN with no
 * warning (and voice/camera work). On boot it:
 *   1. registers with the broker (claims its hostname + token),
 *   2. points the hostname at this box's LAN IP,
 *   3. obtains its OWN Let's Encrypt cert via DNS-01 (the broker writes the
 *      _acme-challenge TXT — no inbound ports, works behind NAT),
 *   4. returns the cert+key so the server can serve HTTPS, and renews.
 *
 * Everything is persisted in the store so restarts reuse the cert. Best-effort:
 * any failure returns null and the server stays HTTP-only.
 *
 * Staging by default; set ORB2_ACME_PRODUCTION=1 for real certs.
 */
// @ts-ignore — acme-client ships CJS, no bundled types we rely on
import acme from 'acme-client'
import { promises as dns, Resolver } from 'node:dns'
import type { Store } from '../store/store.js'
import {
  deviceCertEnabled, registerDevice, setA, setTxt, clearTxt, detectLanIp, type DeviceIdentity,
} from './broker.js'
import { log } from '../log.js'

const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000 // renew 30 days before expiry

export interface DeviceCert { cert: string; key: string; hostname: string }

function dirUrl(): string {
  return process.env.ORB2_ACME_PRODUCTION === '1'
    ? acme.directory.letsencrypt.production
    : acme.directory.letsencrypt.staging
}

async function loadIdentity(store: Store): Promise<DeviceIdentity | null> {
  const device_id = await store.getKv('devicecert:device_id')
  const token = await store.getKv('devicecert:token')
  const hostname = await store.getKv('devicecert:hostname')
  return device_id && token && hostname ? { device_id, token, hostname } : null
}
async function saveIdentity(store: Store, id: DeviceIdentity): Promise<void> {
  const ttl = 60 * 60 * 24 * 3650
  await store.putKv('devicecert:device_id', id.device_id, ttl)
  await store.putKv('devicecert:token', id.token, ttl)
  await store.putKv('devicecert:hostname', id.hostname, ttl)
}

/** Wait until the challenge TXT is visible in public DNS (Cloudflare resolver). */
async function waitForTxt(name: string, value: string, timeoutMs = 60_000): Promise<void> {
  const r = new Resolver()
  r.setServers(['1.1.1.1', '8.8.8.8'])
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const records: string[][] = await new Promise((res, rej) =>
        r.resolveTxt(name, (e, recs) => (e ? rej(e) : res(recs))))
      if (records.some(chunks => chunks.join('') === value)) return
    } catch { /* not present yet */ }
    await new Promise(r2 => setTimeout(r2, 3000))
  }
  // Don't hard-fail — LE may still see it via authoritative DNS.
  log.warn('devicecert_txt_wait_timeout', { name })
}

async function obtainCert(store: Store, id: DeviceIdentity): Promise<DeviceCert | null> {
  // Reuse a persisted ACME account key across renewals.
  let accountKey = await store.getKv('devicecert:account_key')
  if (!accountKey) {
    accountKey = (await acme.crypto.createPrivateKey()).toString()
    await store.putKv('devicecert:account_key', accountKey, 60 * 60 * 24 * 3650)
  }

  const client = new acme.Client({ directoryUrl: dirUrl(), accountKey })
  const [key, csr] = await acme.crypto.createCsr({ commonName: id.hostname })

  const cert: string = await client.auto({
    csr,
    email: process.env.ORB2_ACME_EMAIL || 'admin@orb2.app',
    termsOfServiceAgreed: true,
    challengePriority: ['dns-01'],
    challengeCreateFn: async (_authz: any, challenge: any, keyAuthorization: string) => {
      if (challenge.type !== 'dns-01') throw new Error('device cert needs dns-01')
      // For dns-01, acme-client hands us the already-digested TXT value.
      await setTxt(id, keyAuthorization)
      await waitForTxt(`_acme-challenge.${id.hostname}`, keyAuthorization)
    },
    challengeRemoveFn: async () => { try { await clearTxt(id) } catch { /* ignore */ } },
  })

  const info: any = acme.crypto.readCertificateInfo(cert)
  const expiry = new Date(info.notAfter).getTime()
  await store.putKv('devicecert:cert', cert, 60 * 60 * 24 * 3650)
  await store.putKv('devicecert:key', key.toString(), 60 * 60 * 24 * 3650)
  await store.putKv('devicecert:expiry', String(expiry), 60 * 60 * 24 * 3650)
  log.info('devicecert_issued', { hostname: id.hostname, notAfter: info.notAfter, staging: process.env.ORB2_ACME_PRODUCTION !== '1' })
  return { cert, key: key.toString(), hostname: id.hostname }
}

/**
 * Ensure this box has a valid device cert; returns it (for the HTTPS listener)
 * or null if disabled/unavailable. Registers + sets the A record each call so
 * the LAN IP stays current.
 */
export async function ensureDeviceCert(store: Store): Promise<DeviceCert | null> {
  if (!deviceCertEnabled()) return null
  try {
    let id = await loadIdentity(store)
    if (!id) {
      id = await registerDevice()
      await saveIdentity(store, id)
      log.info('devicecert_registered', { hostname: id.hostname })
    }

    // Keep the A record pointed at our current LAN IP (best-effort).
    const ip = detectLanIp()
    if (ip) { try { await setA(id, ip) } catch (e) { log.warn('devicecert_setA_failed', { error: (e as Error).message }) } }

    // Reuse a still-valid cert.
    const cert = await store.getKv('devicecert:cert')
    const key = await store.getKv('devicecert:key')
    const expiry = Number(await store.getKv('devicecert:expiry') || 0)
    if (cert && key && expiry - Date.now() > RENEW_BEFORE_MS) {
      return { cert, key, hostname: id.hostname }
    }

    return await obtainCert(store, id)
  } catch (err) {
    log.warn('devicecert_failed', { error: (err as Error).message })
    return null
  }
}
