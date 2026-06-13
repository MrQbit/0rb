/**
 * /v1/discover/* endpoints.
 *
 *   GET  /v1/discover/repos     — list configured sources + status
 *   GET  /v1/discover/skills    — flat list with source_repo + trust
 *   GET  /v1/discover/agents
 *   GET  /v1/discover/mcps
 *   POST /v1/discover/refresh   — force re-scan / re-clone (admin)
 */
import type { CallerIdentity } from '../auth/context.js'
import {
  getDiscoveredAgents,
  getDiscoveredMcps,
  getDiscoveredSkills,
  getDiscoveryState,
  refreshDiscovery,
} from './registry.js'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export async function tryHandleDiscoveryRoute(
  req: Request,
  pathname: string,
  identity: CallerIdentity,
  isAdmin: (id: CallerIdentity) => boolean,
): Promise<Response | null> {
  const method = req.method
  if (!pathname.startsWith('/v1/discover/')) return null

  if (method === 'GET' && pathname === '/v1/discover/repos') {
    const s = getDiscoveryState()
    return jsonResponse(200, {
      repos: s.repos.map(r => ({
        kind: r.source.kind,
        target: r.source.kind === 'path' ? r.source.path : r.source.url,
        source_repo: r.source_repo,
        ok: r.ok,
        error: r.error,
        last_refreshed_at: r.last_refreshed_at,
        counts: r.counts,
      })),
      last_refreshed_at: s.lastRefreshedAt,
    })
  }
  if (method === 'GET' && pathname === '/v1/discover/skills') {
    return jsonResponse(200, { skills: getDiscoveredSkills() })
  }
  if (method === 'GET' && pathname === '/v1/discover/agents') {
    return jsonResponse(200, { agents: getDiscoveredAgents() })
  }
  if (method === 'GET' && pathname === '/v1/discover/mcps') {
    return jsonResponse(200, { mcps: getDiscoveredMcps() })
  }
  if (method === 'POST' && pathname === '/v1/discover/refresh') {
    const r = await refreshDiscovery()
    return jsonResponse(200, {
      ok: true,
      repos: r.repos.length,
      skills: r.skills.length,
      agents: r.agents.length,
      mcps: r.mcps.length,
      last_refreshed_at: r.lastRefreshedAt,
    })
  }
  return null
}
