/**
 * Owner-facing routes for the central OAuth relay.
 *
 *   GET /v1/oauth/connect?provider=google   → (owner) redirect to the relay
 *   GET /v1/oauth/return?orb2_relay=…&provider=&state=  → claim + store, back to UI
 */
import type { Store } from '../store/store.js'
import { verifySession, parseCookies, SESSION_COOKIE } from '../auth/session.js'
import {
  RELAY_PROVIDERS, relayStartUrl, relayClaim, saveProviderTokens,
  makeRelayState, consumeRelayState,
} from './relay.js'
import { log } from '../log.js'

function redirect(to: string): Response {
  return new Response(null, { status: 302, headers: { location: to, 'cache-control': 'no-store' } })
}
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Public origin the user is on (for the relay return URL). */
function publicOrigin(req: Request): string {
  const host = req.headers.get('host') || ''
  const proto = req.headers.get('x-forwarded-proto') || (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https')
  return `${proto}://${host}`
}

export async function tryHandleOAuthRelayRoute(
  method: string,
  pathname: string,
  req: Request,
  url: URL,
  store: Store,
): Promise<Response | null> {
  if (pathname === '/v1/oauth/connect' && method === 'GET') {
    // Owner only.
    if (!verifySession(parseCookies(req.headers.get('cookie'))[SESSION_COOKIE])) {
      return json(401, { error: 'Sign in first', code: 'UNAUTHENTICATED' })
    }
    const provider = String(url.searchParams.get('provider') || '')
    if (!RELAY_PROVIDERS.includes(provider as any)) return json(400, { error: 'unknown provider' })
    const state = await makeRelayState(store)
    const returnUrl = `${publicOrigin(req)}/v1/oauth/return`
    return redirect(relayStartUrl(provider, returnUrl, state))
  }

  if (pathname === '/v1/oauth/return' && method === 'GET') {
    const blob = String(url.searchParams.get('orb2_relay') || '')
    const provider = String(url.searchParams.get('provider') || '')
    const state = String(url.searchParams.get('state') || '')
    if (!(await consumeRelayState(store, state))) {
      return redirect('/?connect_error=state')
    }
    if (!blob) return redirect('/?connect_error=noblob')
    try {
      const claimed = await relayClaim(blob)
      await saveProviderTokens(store, claimed.provider || provider, claimed.tokens)
      log.info('oauth_relay_connected', { provider: claimed.provider || provider })
      return redirect(`/?connected=${encodeURIComponent(claimed.provider || provider)}`)
    } catch (e) {
      log.warn('oauth_relay_claim_failed', { error: (e as Error).message })
      return redirect('/?connect_error=claim')
    }
  }

  return null
}
