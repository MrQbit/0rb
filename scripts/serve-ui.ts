/**
 * Local dev UI server: serves web/public/ as a SPA and reverse-proxies
 * /v1/, /a2a/, /healthz, /metrics, /docs, /openapi.json to the API.
 */
import { join } from 'path'
import { existsSync, statSync, readFileSync } from 'fs'

const UI_PORT = parseInt(process.env.UI_PORT ?? '9081', 10)
const API_ORIGIN = process.env.RAK00N_API_URL ?? 'http://localhost:9080'
const WEB_DIR = join(import.meta.dir, '../web/public')

const API_PREFIXES = ['/v1/', '/a2a/', '/healthz', '/readyz', '/metrics', '/docs', '/openapi.json', '/.well-known/']

function isApiPath(path: string): boolean {
  return API_PREFIXES.some(p => path === p || path.startsWith(p))
}

function mimeType(file: string): string {
  if (file.endsWith('.js'))   return 'application/javascript'
  if (file.endsWith('.css'))  return 'text/css'
  if (file.endsWith('.html')) return 'text/html'
  if (file.endsWith('.json')) return 'application/json'
  if (file.endsWith('.svg'))  return 'image/svg+xml'
  if (file.endsWith('.ico'))  return 'image/x-icon'
  if (file.endsWith('.png'))  return 'image/png'
  if (file.endsWith('.woff2')) return 'font/woff2'
  return 'application/octet-stream'
}

const server = Bun.serve({
  port: UI_PORT,
  async fetch(req) {
    const url = new URL(req.url)
    const path = url.pathname

    // Proxy API requests
    if (isApiPath(path)) {
      const upstream = API_ORIGIN + path + (url.search ?? '')
      const headers = new Headers(req.headers)
      headers.delete('host')
      try {
        const resp = await fetch(upstream, {
          method: req.method,
          headers,
          body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
          // @ts-ignore bun-specific
          duplex: 'half',
        })
        return new Response(resp.body, {
          status: resp.status,
          headers: resp.headers,
        })
      } catch (err) {
        return new Response(JSON.stringify({ error: 'API proxy error', detail: String(err) }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        })
      }
    }

    // /web/* legacy alias → strip prefix
    const filePath = path.startsWith('/web/') ? path.slice(4) : path

    // Serve static file
    const candidate = join(WEB_DIR, filePath)
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return new Response(readFileSync(candidate), {
        headers: { 'content-type': mimeType(candidate) },
      })
    }

    // SPA fallback
    return new Response(readFileSync(join(WEB_DIR, 'index.html')), {
      headers: { 'content-type': 'text/html' },
    })
  },
})

console.log(`[ui] Serving web/public/ on http://localhost:${UI_PORT}`)
console.log(`[ui] Proxying API → ${API_ORIGIN}`)
