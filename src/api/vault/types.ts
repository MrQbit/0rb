export type VaultNoteFrontmatter = {
  tags: string[]
  created: string
  updated: string
  aliases: string[]
  source?: string
  session?: string
}

export type VaultNote = {
  path: string
  title: string
  content: string
  frontmatter: VaultNoteFrontmatter
  links: string[] // extracted [[wikilinks]]
}

export type VaultIndexEntry = {
  path: string
  title: string
  tags: string[]
  aliases: string[]
  links: string[]
  snippet: string // first 200 chars of body for search display
  updatedAt: string
}

export type VaultSearchResult = {
  path: string
  title: string
  tags: string[]
  snippet: string
  score: number
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/

export function parseFrontmatter(raw: string): { frontmatter: VaultNoteFrontmatter; body: string } {
  const match = raw.match(FRONTMATTER_RE)
  const defaults: VaultNoteFrontmatter = {
    tags: [],
    created: new Date().toISOString().slice(0, 10),
    updated: new Date().toISOString().slice(0, 10),
    aliases: [],
  }

  if (!match) {
    return { frontmatter: defaults, body: raw }
  }

  const yamlBlock = match[1]!
  const body = raw.slice(match[0].length)
  const fm = { ...defaults }

  for (const line of yamlBlock.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/)
    if (!kv) continue
    const [, key, val] = kv
    if (!key || val === undefined) continue

    if (key === 'tags' || key === 'aliases') {
      // Parse YAML array: [a, b, c] or - a\n- b
      const arrMatch = val.match(/^\[(.*)\]$/)
      if (arrMatch) {
        fm[key] = arrMatch[1]!.split(',').map(s => s.trim()).filter(Boolean)
      }
    } else if (key === 'created' || key === 'updated') {
      fm[key] = val.trim()
    } else if (key === 'source' || key === 'session') {
      fm[key as 'source' | 'session'] = val.trim()
    }
  }

  return { frontmatter: fm, body }
}

export function serializeFrontmatter(fm: VaultNoteFrontmatter): string {
  const lines = ['---']
  lines.push(`tags: [${fm.tags.join(', ')}]`)
  lines.push(`created: ${fm.created}`)
  lines.push(`updated: ${fm.updated}`)
  if (fm.aliases.length > 0) lines.push(`aliases: [${fm.aliases.join(', ')}]`)
  if (fm.source) lines.push(`source: ${fm.source}`)
  if (fm.session) lines.push(`session: ${fm.session}`)
  lines.push('---')
  return lines.join('\n')
}

export function extractWikilinks(body: string): string[] {
  const links: string[] = []
  const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g
  let m
  while ((m = re.exec(body)) !== null) {
    links.push(m[1]!.trim())
  }
  return [...new Set(links)]
}

export function titleFromPath(p: string): string {
  return p.replace(/\.md$/, '').split('/').pop() || p
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}
