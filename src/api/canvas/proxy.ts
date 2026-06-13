/**
 * Preview proxy — reverse-proxies HTTP and WebSocket requests from the
 * console's preview iframe to the canvas pod's Vite dev server.
 *
 * Route: GET/WS /v1/preview/{sessionId}/**
 *
 * Auth: same session identity check as /v1/chat (owner or service
 * mode). The iframe src uses the session's auth cookie/token.
 *
 * Vite HMR works transparently because the WebSocket upgrade is
 * forwarded as-is; the Vite client in the iframe connects to the
 * same origin and the proxy tunnels the frames.
 */
import type { Store } from '../store/store.js'
import { getCanvasPod } from './dispatch.js'
import { attributionFor, isAdmin, type CallerIdentity } from '../auth/context.js'

const PREVIEW_PATH_RE = /^\/v1\/preview\/([A-Za-z0-9_-]+)(\/.*)?$/

const SENSITIVE_FORWARD_HEADERS = [
  'authorization',
  'cookie',
  'x-api-key',
  'x-foundry-token',
  'proxy-authorization',
]

export function matchPreviewRoute(pathname: string): { sessionId: string; subpath: string } | null {
  const m = PREVIEW_PATH_RE.exec(pathname)
  if (!m) return null
  return { sessionId: m[1]!, subpath: m[2] || '/' }
}

function buildForwardHeaders(src: Headers): Headers {
  const out = new Headers(src)
  for (const h of SENSITIVE_FORWARD_HEADERS) out.delete(h)
  return out
}

export async function handlePreviewProxy(
  req: Request,
  sessionId: string,
  subpath: string,
  store: Store,
  identity: CallerIdentity,
): Promise<Response> {
  const meta = await store.getSessionMeta(sessionId)
  if (meta?.ownerOid) {
    const callerOid = attributionFor(identity).oid
    if (meta.ownerOid !== callerOid && !isAdmin(identity)) {
      return new Response(
        JSON.stringify({ error: 'Forbidden — not the session owner', code: 'SESSION_FORBIDDEN' }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      )
    }
  }

  const info = await getCanvasPod(store, sessionId)
  if (!info || info.state !== 'running') {
    return new Response(JSON.stringify({ error: 'No active canvas session' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
  }

  const targetUrl = `http://${info.podIp}:${info.vitePort}${subpath}`

  const upgrade = req.headers.get('upgrade')
  if (upgrade?.toLowerCase() === 'websocket') {
    return new Response(null, {
      status: 101,
      headers: {
        'X-Canvas-WS-Target': `ws://${info.podIp}:${info.vitePort}${subpath}`,
      },
    })
  }

  try {
    const proxyRes = await fetch(targetUrl, {
      method: req.method,
      headers: buildForwardHeaders(req.headers),
      body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
      signal: AbortSignal.timeout(30_000),
    })

    const headers = new Headers(proxyRes.headers)
    // Remove hop-by-hop headers
    headers.delete('transfer-encoding')
    headers.delete('connection')
    // Allow iframe embedding from the console origin
    headers.set('X-Frame-Options', 'SAMEORIGIN')

    return new Response(proxyRes.body, {
      status: proxyRes.status,
      headers,
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: `Preview proxy error: ${(err as Error).message}` }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    })
  }
}
