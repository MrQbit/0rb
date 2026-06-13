/**
 * MCP management routes.
 *
 *   GET    /v1/mcps                — unified list (built-in / skill / user / discovered)
 *   POST   /v1/mcps                — register a stand-alone MCP server
 *   DELETE /v1/mcps/{name}         — delete a user-registered MCP (built-ins / bundled / discovered are read-only)
 *   POST   /v1/mcps/{name}/probe   — connect once via mcpConnect and return tool list
 *
 * Used by the Settings → MCPs pane in the console.
 */
import type { Store } from '../store/store.js'
import type { CallerIdentity } from '../auth/context.js'
import { getDefaultMcpServers } from './defaultServers.js'
import {
  listUserMcpServers,
  saveUserMcpServer,
  deleteUserMcpServer,
  getUserMcpServer,
} from './userServers.js'
import { getDiscoveredMcps } from '../discovery/registry.js'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  for (const [k, v] of Object.entries(headers)) {
    if (!v) { out[k] = ''; continue }
    if (typeof v === 'string' && v.includes('${') && v.endsWith('}')) {
      out[k] = v
    } else {
      const s = String(v)
      out[k] = s.length <= 4 ? '***' : `${s.slice(0, 2)}***${s.slice(-2)}`
    }
  }
  return out
}

type McpView = {
  name: string
  url: string
  transport: string
  headers: Record<string, string>
  origin: 'builtin' | 'user' | 'skill' | 'discovered'
  source_repo?: string
  source_skill?: string
  registered_at?: string
}

async function getAllSkillsSafe() {
  try {
    const mod = await import('../skills/registry.js') as { getAllSkills?: () => any[] }
    return mod.getAllSkills ? mod.getAllSkills() : []
  } catch {
    return []
  }
}

async function buildList(store: Store): Promise<McpView[]> {
  const list: McpView[] = []
  for (const s of getDefaultMcpServers()) {
    list.push({
      name: s.name,
      url: s.url,
      transport: s.transport,
      headers: redactHeaders(s.headers),
      origin: 'builtin',
    })
  }
  const skills = await getAllSkillsSafe()
  for (const skill of skills) {
    for (const s of skill.mcpServers || []) {
      list.push({
        name: s.name,
        url: s.url,
        transport: s.transport,
        headers: redactHeaders(s.headers),
        origin: 'skill',
        source_skill: skill.name,
      })
    }
  }
  for (const s of await listUserMcpServers(store)) {
    list.push({
      name: s.name,
      url: s.url,
      transport: s.transport,
      headers: redactHeaders(s.headers),
      origin: 'user',
      registered_at: s.registered_at,
    })
  }
  for (const m of getDiscoveredMcps()) {
    const cfg = (m.config || {}) as Record<string, unknown>
    list.push({
      name: m.name,
      url: typeof cfg.url === 'string' ? cfg.url : (typeof cfg.command === 'string' ? cfg.command : ''),
      transport: typeof cfg.type === 'string' ? cfg.type : (typeof cfg.transport === 'string' ? cfg.transport : 'streamable_http'),
      headers: redactHeaders(typeof cfg.headers === 'object' && cfg.headers ? cfg.headers as Record<string, string> : {}),
      origin: 'discovered',
      source_repo: m.source_repo,
    })
  }
  return list
}

export async function tryHandleMcpRoute(
  req: Request,
  pathname: string,
  identity: CallerIdentity,
  ctx: { store: Store },
): Promise<Response | null> {
  if (!pathname.startsWith('/v1/mcps')) return null
  const method = req.method

  if (method === 'GET' && pathname === '/v1/mcps') {
    const mcps = await buildList(ctx.store)
    return jsonResponse(200, { mcps })
  }

  if (method === 'POST' && pathname === '/v1/mcps') {
    let body: any
    try { body = await req.json() } catch { return jsonResponse(400, { error: 'invalid JSON body' }) }
    try {
      const saved = await saveUserMcpServer(
        ctx.store,
        {
          name: String(body?.name || ''),
          url: String(body?.url || ''),
          transport: String(body?.transport || 'streamable_http'),
          headers: typeof body?.headers === 'object' && body?.headers ? body.headers : {},
        },
        identity.type === 'apikey' ? identity.record.id : identity.type === 'service' ? identity.agentId : undefined,
      )
      return jsonResponse(201, {
        ok: true,
        mcp: {
          name: saved.name,
          url: saved.url,
          transport: saved.transport,
          headers: redactHeaders(saved.headers),
          origin: 'user' as const,
          registered_at: saved.registered_at,
        },
      })
    } catch (err) {
      return jsonResponse(400, { error: (err as Error).message })
    }
  }

  const named = pathname.match(/^\/v1\/mcps\/([a-z0-9][a-z0-9_-]{0,63})(\/probe)?$/i)
  if (named) {
    const name = named[1]!
    const isProbe = !!named[2]

    if (method === 'DELETE' && !isProbe) {
      const existed = await deleteUserMcpServer(ctx.store, name)
      if (!existed) {
        return jsonResponse(404, {
          error: 'MCP not found or not user-registered (built-ins, skill-bundled and discovered are read-only)',
        })
      }
      return jsonResponse(200, { ok: true })
    }

    if (method === 'POST' && isProbe) {
      const user = await getUserMcpServer(ctx.store, name)
      const all = await buildList(ctx.store)
      const target = all.find(m => m.name === name)
      if (!target) return jsonResponse(404, { error: 'unknown MCP' })

      // Resolve unredacted headers if it's a user-registered server.
      const headers = user
        ? user.headers
        : (() => {
          // For built-ins fall back to original definitions.
          const built = getDefaultMcpServers().find(s => s.name === name)
          if (built) return built.headers
          return {}
        })()
      const url = user ? user.url : target.url
      const transport = user ? user.transport : target.transport

      try {
        const { connectSkillMcpServers } = await import('../skills/mcpConnect.js')
        const result = await connectSkillMcpServers([{
          name, url, transport, headers,
        } as any], process.env.MCP_SERVER_TOKEN)
        const tools: { name: string; description?: string }[] = []
        let error: string | undefined
        for (const c of result.connections || []) {
          if (c.type !== 'connected') {
            error = (c as any).error || 'failed to connect'
            continue
          }
          try {
            const list = await (c as any).client.listTools()
            for (const t of (list?.tools || [])) {
              tools.push({ name: t.name, description: t.description })
            }
          } catch (err) {
            error = (err as Error).message
          }
        }
        try { await result.cleanup?.() } catch { /* ignore */ }
        return jsonResponse(200, { ok: error == null, name, tools, error })
      } catch (err) {
        return jsonResponse(200, { ok: false, name, error: (err as Error).message })
      }
    }
  }

  return null
}
