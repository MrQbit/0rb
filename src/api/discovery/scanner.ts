/**
 * Walks a checked-out repo and parses the four config surfaces:
 *
 *   .orb2/skills/*.md      -> SkillDefinition
 *   .orb2/agents/*.md      -> AgentDefinition (frontmatter only)
 *   .mcp.json              -> { mcpServers: { name: McpConfig } }
 *   mcp_servers.json       -> same shape, alternate filename
 *
 * Frontmatter parsing kept intentionally lightweight (YAML keys we
 * understand) so we don't pull the whole TUI loader into the API.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

export type DiscoveredSkill = {
  name: string
  description: string
  instructions: string
  source_repo: string
  trust: 'discovered'
}

export type DiscoveredAgent = {
  id: string
  name: string
  description: string
  prompt: string
  tools?: string[]
  model?: string
  source_repo: string
  trust: 'discovered'
}

export type DiscoveredMcp = {
  name: string
  config: Record<string, unknown>
  source_repo: string
  trust: 'discovered'
}

export type ScanResult = {
  skills: DiscoveredSkill[]
  agents: DiscoveredAgent[]
  mcps: DiscoveredMcp[]
  errors: { path: string; message: string }[]
}

function parseFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
  if (!raw.startsWith('---')) return { fm: {}, body: raw }
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return { fm: {}, body: raw }
  const head = raw.slice(3, end)
  const body = raw.slice(end + 4).replace(/^\r?\n/, '')
  const fm: Record<string, string> = {}
  for (const line of head.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const m = t.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/)
    if (m) fm[m[1]!.trim()] = m[2]!.trim().replace(/^["']|["']$/g, '')
  }
  return { fm, body }
}

function parseToolsList(s: string | undefined): string[] | undefined {
  if (!s) return undefined
  // Accept comma-sep list or YAML inline `[a, b, c]`.
  const inner = s.replace(/^\[|\]$/g, '')
  const out = inner.split(',').map(t => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
  return out.length > 0 ? out : undefined
}

function readDirSafe(p: string): string[] {
  try { return readdirSync(p) } catch { return [] }
}

export function scanRepo(repoRoot: string, sourceLabel: string): ScanResult {
  const result: ScanResult = { skills: [], agents: [], mcps: [], errors: [] }
  if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) {
    result.errors.push({ path: repoRoot, message: 'not a directory' })
    return result
  }

  // Skills
  const skillsDir = join(repoRoot, '.orb2', 'skills')
  for (const f of readDirSafe(skillsDir)) {
    if (!f.endsWith('.md')) continue
    const filePath = join(skillsDir, f)
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const { fm, body } = parseFrontmatter(raw)
      const name = fm.name || basename(f, '.md')
      const description = fm.description || ''
      if (!name || !description) continue
      result.skills.push({
        name: `${sourceLabel}/${name}`,
        description,
        instructions: body.trim(),
        source_repo: sourceLabel,
        trust: 'discovered',
      })
    } catch (err) {
      result.errors.push({ path: filePath, message: (err as Error).message })
    }
  }

  // Agents
  const agentsDir = join(repoRoot, '.orb2', 'agents')
  for (const f of readDirSafe(agentsDir)) {
    if (!f.endsWith('.md')) continue
    const filePath = join(agentsDir, f)
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const { fm, body } = parseFrontmatter(raw)
      const name = fm.name || basename(f, '.md')
      if (!name) continue
      const description = fm.description || ''
      if (!description) continue
      result.agents.push({
        id: `${sourceLabel}/${name}`,
        name,
        description,
        prompt: body.trim(),
        tools: parseToolsList(fm.tools),
        model: fm.model || undefined,
        source_repo: sourceLabel,
        trust: 'discovered',
      })
    } catch (err) {
      result.errors.push({ path: filePath, message: (err as Error).message })
    }
  }

  // MCP configs
  for (const fname of ['.mcp.json', 'mcp_servers.json']) {
    const filePath = join(repoRoot, fname)
    if (!existsSync(filePath)) continue
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const servers = (parsed.mcpServers ?? parsed) as Record<string, Record<string, unknown>>
      for (const [name, cfg] of Object.entries(servers)) {
        if (!cfg || typeof cfg !== 'object') continue
        result.mcps.push({
          name: `${sourceLabel}/${name}`,
          config: cfg,
          source_repo: sourceLabel,
          trust: 'discovered',
        })
      }
    } catch (err) {
      result.errors.push({ path: filePath, message: (err as Error).message })
    }
  }

  return result
}
