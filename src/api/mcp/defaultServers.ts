import type { SkillMcpServer } from '../skills/loader.js'

/** All default MCP servers configured for this environment.
 *  Operators can supply a custom list via RAK00N_DEFAULT_MCPS_JSON (JSON array of SkillMcpServer). */
export function getDefaultMcpServers(): SkillMcpServer[] {
  if (process.env.RAK00N_DEFAULT_MCPS_DISABLED === '1') return []

  if (process.env.RAK00N_DEFAULT_MCPS_JSON) {
    try {
      const parsed = JSON.parse(process.env.RAK00N_DEFAULT_MCPS_JSON)
      if (Array.isArray(parsed)) return parsed.filter(isValidServer)
    } catch (err) {
      console.warn(
        `[mcp-defaults] RAK00N_DEFAULT_MCPS_JSON parse failed, falling back to empty: ${(err as Error).message}`,
      )
    }
  }

  return []
}

/** Per-turn entry point: returns the default MCP servers for the given message. */
export function getDefaultMcpServersForMessage(_message: string | undefined | null): SkillMcpServer[] {
  return getDefaultMcpServers()
}

function isValidServer(v: unknown): v is SkillMcpServer {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.name === 'string' && typeof o.url === 'string'
}
