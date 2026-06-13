/**
 * Bootstrap the first admin API key.
 *
 * When the operator sets `ORB2_BOOTSTRAP_ADMIN_KEY=orb2_<hex>` on a
 * fresh deployment (the configured value lives in a K8s Secret, not
 * a ConfigMap), this function runs once on startup, hashes the seed,
 * and persists it as the first admin record. Subsequent startups
 * find an admin already present and become a no-op.
 *
 * The seed value is never logged; only the resulting 8-char public
 * id is emitted at INFO so an operator can confirm the bootstrap
 * landed without leaking the key.
 */
import { log } from '../log.js'
import { hashApiKey, isApiKeyShape } from './apiKey.js'
import type { Store } from '../store/store.js'

export async function bootstrapAdminKey(store: Store): Promise<void> {
  const seed = process.env.ORB2_BOOTSTRAP_ADMIN_KEY?.trim()
  if (!seed) return
  if (!isApiKeyShape(seed)) {
    log.warn('bootstrap_admin_skipped', {
      reason: 'ORB2_BOOTSTRAP_ADMIN_KEY is not a valid orb2_<64hex> shape',
    })
    return
  }

  const existing = await store.listAllApiKeys()
  if (existing.some(k => k.record.admin)) {
    log.info('bootstrap_admin_skipped', { reason: 'admin already present' })
    return
  }

  const { hash, id } = hashApiKey(seed)
  if (existing.some(k => k.record.id === id)) {
    log.info('bootstrap_admin_skipped', { reason: 'seed key already minted (not admin)' })
    return
  }

  await store.putApiKey(hash, {
    id,
    ownerOid: 'app:bootstrap-admin',
    ownerEmail: 'bootstrap@orb2.local',
    name: 'bootstrap-admin',
    admin: true,
    createdAt: new Date().toISOString(),
  })
  log.info('bootstrap_admin_minted', { keyId: id })
}
