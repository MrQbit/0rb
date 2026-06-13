/**
 * Docker widget routes — let the Docker widget self-refresh and let the user
 * (and agent) control containers.
 *   GET  /v1/docker/list      (session) → [{ id, name, image, state, cpu, mem }]
 *   POST /v1/docker/control   (session) → { action: stop|start|restart|pull|logs, target?, image? }
 */
import { authEnabled, verifySession, parseCookies, SESSION_COOKIE } from '../auth/session.js'
import { dockerEnabled, dockerList, dockerControl } from './dockerc.js'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
function authed(req: Request): boolean {
  if (!authEnabled()) return true
  const a = req.headers.get('authorization') ?? ''
  let token = /^Bearer\s+/i.test(a) ? a.replace(/^Bearer\s+/i, '').trim() : ''
  if (!token) token = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE] ?? ''
  return !!(token && verifySession(token))
}

export async function tryDockerRoute(req: Request, method: string, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith('/v1/docker/')) return null
  if (!authed(req)) return json(401, { error: 'authentication required' })
  if (!dockerEnabled()) return json(400, { error: 'docker ops not enabled' })

  if (method === 'GET' && pathname === '/v1/docker/list') {
    return json(200, { containers: await dockerList(true) })
  }
  if (method === 'POST' && pathname === '/v1/docker/control') {
    const body = (await req.json().catch(() => ({}))) as any
    const r = await dockerControl(String(body.action || ''), body.target, body.image)
    return json(r.ok ? 200 : 400, r)
  }
  return null
}
