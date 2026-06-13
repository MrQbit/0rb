import { readFileSync, readdirSync } from 'fs'
import { join, extname } from 'path'

export type SkillMcpServer = {
  name: string
  url: string
  transport: string
  headers: Record<string, string>
}

export type SkillDefinition = {
  name: string
  description: string
  instructions: string
  mcpServers: SkillMcpServer[]
  keywords?: string
}

export function loadSkills(skillsDir: string): SkillDefinition[] {
  let entries: string[]
  try {
    entries = readdirSync(skillsDir)
  } catch {
    return []
  }

  const skills: SkillDefinition[] = []
  for (const file of entries) {
    if (extname(file) !== '.md') continue
    try {
      const raw = readFileSync(join(skillsDir, file), 'utf-8')
      const skill = parseSkillFile(raw)
      if (skill) skills.push(skill)
    } catch {
      // skip unparseable files
    }
  }
  return skills
}

function parseSkillFile(content: string): SkillDefinition | null {
  if (!content.startsWith('---')) return null
  const parts = content.split('---', 3)
  if (parts.length < 3) return null

  const frontmatter = parseYamlFrontmatter(parts[1]!)
  if (!frontmatter || !frontmatter.name || !frontmatter.description) return null

  const instructions = parts.slice(2).join('---').trim()
  const mcpServers: SkillMcpServer[] = []

  if (frontmatter.mcp_servers && typeof frontmatter.mcp_servers === 'object') {
    for (const [name, cfg] of Object.entries(frontmatter.mcp_servers as Record<string, any>)) {
      if (!cfg?.url) continue
      const headers: Record<string, string> = {}
      if (cfg.headers && typeof cfg.headers === 'object') {
        for (const [k, v] of Object.entries(cfg.headers)) {
          headers[k] = String(v) // keep raw ${VAR} templates; resolved at connect time
        }
      }
      mcpServers.push({
        name,
        url: String(cfg.url), // raw template; resolved at connect time
        transport: cfg.transport || 'streamable_http',
        headers,
      })
    }
  }

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    instructions,
    mcpServers,
    keywords: frontmatter.keywords || undefined,
  }
}

function parseYamlFrontmatter(yaml: string): Record<string, any> | null {
  try {
    const result: Record<string, any> = {}
    const lines = yaml.split('\n')
    const stack: { indent: number; obj: Record<string, any>; key: string }[] = []
    let currentObj = result

    let i = 0
    while (i < lines.length) {
      const line = lines[i]!
      i += 1

      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue

      const indent = line.search(/\S/)
      const match = trimmed.match(/^([^:]+):\s*(.*)$/)
      if (!match) continue

      const key = match[1]!.trim()
      let value = match[2]!.trim()

      // Remove surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }

      // Pop stack to find the right parent
      while (stack.length > 0 && indent <= stack[stack.length - 1]!.indent) {
        stack.pop()
        currentObj = stack.length > 0 ? stack[stack.length - 1]!.obj[stack[stack.length - 1]!.key] : result
      }

      // Block-scalar indicators ("|" literal, ">" folded). Consume every
      // subsequent line whose indent is strictly greater than the key's
      // indent, then stitch them together. Literal preserves newlines;
      // folded collapses single newlines into spaces (blank lines become
      // a single newline). Trailing newline is stripped (chomp "-").
      if (value === '|' || value === '>' || value === '|-' || value === '>-') {
        const folded = value.startsWith('>')
        const lit = value.startsWith('|')
        const collected: string[] = []
        while (i < lines.length) {
          const next = lines[i]!
          const nextIndent = next.search(/\S/)
          if (next.trim() === '') {
            // Preserve a blank line if more indented content follows
            collected.push('')
            i += 1
            continue
          }
          if (nextIndent <= indent) break
          collected.push(next.slice(indent + 1))
          i += 1
        }
        // Trim trailing blank lines
        while (collected.length > 0 && collected[collected.length - 1] === '') {
          collected.pop()
        }
        let joined: string
        if (lit) {
          joined = collected.join('\n')
        } else {
          // folded: blank lines → "\n", others → " "
          const parts: string[] = []
          let buf = ''
          for (const ln of collected) {
            if (ln === '') {
              if (buf) parts.push(buf)
              buf = ''
              parts.push('')
            } else {
              buf = buf ? `${buf} ${ln}` : ln
            }
          }
          if (buf) parts.push(buf)
          joined = parts.join('\n').replace(/\n{2,}/g, '\n')
        }
        currentObj[key] = joined
        continue
      }

      if (value === '') {
        // Nested object
        currentObj[key] = {}
        stack.push({ indent, obj: currentObj, key })
        currentObj = currentObj[key]
      } else {
        currentObj[key] = value
      }
    }

    return result
  } catch {
    return null
  }
}
