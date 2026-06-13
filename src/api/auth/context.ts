/**
 * Request authentication context.
 *
 * The API trusts its network boundary: it runs inside an ART agent
 * pod where the agentgateway + NetworkPolicy + cluster RBAC form the
 * outer trust ring. We do not authenticate end users at this layer.
 *
 * Two identities exist:
 *
 *   1. `apikey` — `Authorization: Bearer rak00n_<hex>`. Hash → store
 *      `apikey:<hash>` → record. The plaintext key is never stored.
 *      Keys are minted by holders of an `admin: true` key (bootstrap)
 *      or via the dedicated SPA's "API Keys" tab.
 *
 *   2. `service` — anonymous internal trust. Returned for unsigned
 *      requests when `RAK00N_API_AUTH_REQUIRED=0`. Used by
 *      health/readiness/metrics, by the dedicated SPA serving its
 *      static UI, and (in dev) by the SPA's calls. In prod
 *      (`RAK00N_API_AUTH_REQUIRED=1`) every /v1/* call must carry a key.
 */
import type { Store, ApiKeyRecord } from '../store/store.js'
import { hashApiKey, isApiKeyShape, touchApiKey } from './apiKey.js'
import { isSessionToken, verifySession, parseCookies, SESSION_COOKIE } from './session.js'

export type CallerIdentity =
  | {
      type: 'apikey'
      record: ApiKeyRecord
      keyHash: string
    }
  | {
      type: 'service'
      /** Identifier for audit attribution; usually the agent name. */
      agentId: string
    }
  | {
      // Username/password session (console, channels, iOS app). The
      // single-user owner — treated as admin.
      type: 'user'
      username: string
    }

export async function resolveIdentity(
  req: Request,
  store: Store,
): Promise<CallerIdentity | null> {
  // Bearer first: either an API key or a signed session token (iOS/app).
  const auth = req.headers.get('authorization') ?? ''
  if (/^Bearer\s+/i.test(auth)) {
    const token = auth.replace(/^Bearer\s+/i, '').trim()
    if (isSessionToken(token)) {
      const payload = verifySession(token)
      if (payload) return { type: 'user', username: payload.u }
      return null
    }
    if (isApiKeyShape(token)) {
      const { hash } = hashApiKey(token)
      const record = await store.getApiKey(hash)
      if (record) {
        // Fire-and-forget last-used touch.
        touchApiKey(store, hash).catch(() => {})
        return { type: 'apikey', record, keyHash: hash }
      }
    }
    // Unknown / malformed Bearer ⇒ no identity.
    return null
  }
  // Browser session cookie (set by /v1/auth/login). The browser also
  // sends it on the voice WebSocket upgrade, so voice works post-login.
  const sessionFromCookie = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE]
  if (sessionFromCookie) {
    const payload = verifySession(sessionFromCookie)
    if (payload) return { type: 'user', username: payload.u }
  }
  return null
}

/**
 * Ambient "service" identity used when `RAK00N_API_AUTH_REQUIRED=0`.
 * Returns null when auth is required so the caller is forced to send
 * a Bearer.
 */
export function resolveServiceIdentity(agentId: string): CallerIdentity | null {
  if ((process.env.RAK00N_API_AUTH_REQUIRED ?? '0') === '1') return null
  return { type: 'service', agentId }
}

export function isAdmin(identity: CallerIdentity | null): boolean {
  if (!identity) return false
  // The logged-in single-user owner is admin.
  if (identity.type === 'user') return true
  if (identity.type !== 'apikey') return false
  return identity.record.admin === true
}

export function attributionFor(identity: CallerIdentity | null): {
  oid?: string
  keyId?: string
  email?: string
  tenantId?: string
} {
  const tenantId = process.env.RAK00N_TENANT_ID || undefined
  if (!identity) return { tenantId }
  if (identity.type === 'apikey') {
    return {
      oid: identity.record.ownerOid,
      keyId: identity.record.id,
      email: identity.record.ownerEmail || undefined,
      tenantId,
    }
  }
  if (identity.type === 'user') {
    return { oid: `user:${identity.username}`, tenantId }
  }
  return { oid: `service:${identity.agentId}`, tenantId }
}
