import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Store } from '../store/store.js'
import {
  parseFrontmatter,
  serializeFrontmatter,
  extractWikilinks,
  titleFromPath,
  slugify,
  type VaultNote,
  type VaultNoteFrontmatter,
  type VaultIndexEntry,
  type VaultSearchResult,
} from './types.js'

const INDEX_KEY = 'vault:index'
const INDEX_TTL = 0 // no expiry

function getVaultDir(): string {
  return process.env.ORB2_VAULT_DIR || '/workspace/.vault'
}

function ensureVaultDir(): string {
  const dir = getVaultDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export class VaultStore {
  constructor(private store: Store) {}

  // ─── Filesystem CRUD ───

  async write(notePath: string, body: string, opts?: {
    tags?: string[]
    aliases?: string[]
    source?: string
    session?: string
  }): Promise<VaultNote> {
    const dir = ensureVaultDir()
    const safePath = notePath.endsWith('.md') ? notePath : `${notePath}.md`
    const fullPath = path.join(dir, safePath)
    const parentDir = path.dirname(fullPath)
    if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true })

    const today = new Date().toISOString().slice(0, 10)
    let fm: VaultNoteFrontmatter

    // Preserve existing frontmatter if updating
    if (existsSync(fullPath)) {
      const existing = readFileSync(fullPath, 'utf-8')
      const parsed = parseFrontmatter(existing)
      fm = {
        ...parsed.frontmatter,
        updated: today,
        tags: opts?.tags ?? parsed.frontmatter.tags,
        aliases: opts?.aliases ?? parsed.frontmatter.aliases,
      }
      if (opts?.source) fm.source = opts.source
      if (opts?.session) fm.session = opts.session
    } else {
      fm = {
        tags: opts?.tags || [],
        created: today,
        updated: today,
        aliases: opts?.aliases || [],
        source: opts?.source,
        session: opts?.session,
      }
    }

    const links = extractWikilinks(body)
    const fileContent = `${serializeFrontmatter(fm)}\n${body}`
    writeFileSync(fullPath, fileContent, 'utf-8')

    const note: VaultNote = {
      path: safePath,
      title: titleFromPath(safePath),
      content: body,
      frontmatter: fm,
      links,
    }

    await this.updateIndex(note)
    return note
  }

  async read(notePath: string): Promise<VaultNote | null> {
    const dir = getVaultDir()
    const safePath = notePath.endsWith('.md') ? notePath : `${notePath}.md`
    const fullPath = path.join(dir, safePath)

    if (!existsSync(fullPath)) return null
    const raw = readFileSync(fullPath, 'utf-8')
    const { frontmatter, body } = parseFrontmatter(raw)
    const links = extractWikilinks(body)

    return {
      path: safePath,
      title: titleFromPath(safePath),
      content: body,
      frontmatter,
      links,
    }
  }

  async delete(notePath: string): Promise<boolean> {
    const dir = getVaultDir()
    const safePath = notePath.endsWith('.md') ? notePath : `${notePath}.md`
    const fullPath = path.join(dir, safePath)

    if (!existsSync(fullPath)) return false
    unlinkSync(fullPath)
    await this.removeFromIndex(safePath)
    return true
  }

  async list(): Promise<VaultIndexEntry[]> {
    const cached = await this.getIndex()
    if (cached.length > 0) return cached

    // Rebuild index from filesystem
    return this.rebuildIndex()
  }

  // ─── Search ───

  async search(query: string, tags?: string[], limit = 10): Promise<VaultSearchResult[]> {
    const index = await this.list()
    const queryLower = query.toLowerCase()
    const queryTerms = queryLower.split(/\s+/).filter(Boolean)

    const scored: VaultSearchResult[] = index
      .map(entry => {
        let score = 0

        // Tag match (highest weight)
        if (tags && tags.length > 0) {
          const tagMatches = tags.filter(t => entry.tags.includes(t)).length
          score += tagMatches * 10
        }

        // Title match
        const titleLower = entry.title.toLowerCase()
        for (const term of queryTerms) {
          if (titleLower.includes(term)) score += 5
        }

        // Alias match
        for (const alias of entry.aliases) {
          const aliasLower = alias.toLowerCase()
          for (const term of queryTerms) {
            if (aliasLower.includes(term)) score += 4
          }
        }

        // Tag text match
        for (const tag of entry.tags) {
          const tagLower = tag.toLowerCase()
          for (const term of queryTerms) {
            if (tagLower.includes(term)) score += 3
          }
        }

        // Snippet/body match
        const snippetLower = entry.snippet.toLowerCase()
        for (const term of queryTerms) {
          if (snippetLower.includes(term)) score += 2
        }

        // Link match
        for (const link of entry.links) {
          const linkLower = link.toLowerCase()
          for (const term of queryTerms) {
            if (linkLower.includes(term)) score += 1
          }
        }

        return {
          path: entry.path,
          title: entry.title,
          tags: entry.tags,
          snippet: entry.snippet,
          score,
        }
      })
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)

    return scored
  }

  async findRelatedNotes(notePath: string, limit = 5): Promise<VaultSearchResult[]> {
    const note = await this.read(notePath)
    if (!note) return []

    // Search by the note's tags + linked note names
    const terms = [...note.frontmatter.tags, ...note.links].join(' ')
    const results = await this.search(terms, note.frontmatter.tags, limit + 1)
    // Exclude self
    return results.filter(r => r.path !== notePath).slice(0, limit)
  }

  // ─── Index management (Redis-backed) ───

  private async getIndex(): Promise<VaultIndexEntry[]> {
    const raw = await this.store.getKv(INDEX_KEY)
    if (!raw) return []
    try { return JSON.parse(raw) } catch { return [] }
  }

  private async setIndex(entries: VaultIndexEntry[]): Promise<void> {
    await this.store.putKv(INDEX_KEY, JSON.stringify(entries), INDEX_TTL)
  }

  private async updateIndex(note: VaultNote): Promise<void> {
    const entries = await this.getIndex()
    const existing = entries.findIndex(e => e.path === note.path)
    const entry: VaultIndexEntry = {
      path: note.path,
      title: note.title,
      tags: note.frontmatter.tags,
      aliases: note.frontmatter.aliases,
      links: note.links,
      snippet: note.content.replace(/\n/g, ' ').slice(0, 200),
      updatedAt: note.frontmatter.updated,
    }
    if (existing >= 0) {
      entries[existing] = entry
    } else {
      entries.push(entry)
    }
    await this.setIndex(entries)
  }

  private async removeFromIndex(notePath: string): Promise<void> {
    const entries = await this.getIndex()
    await this.setIndex(entries.filter(e => e.path !== notePath))
  }

  async rebuildIndex(): Promise<VaultIndexEntry[]> {
    const dir = getVaultDir()
    if (!existsSync(dir)) return []

    const entries: VaultIndexEntry[] = []
    const walk = (d: string, prefix: string) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          walk(path.join(d, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name)
        } else if (entry.name.endsWith('.md')) {
          const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
          const fullPath = path.join(d, entry.name)
          try {
            const raw = readFileSync(fullPath, 'utf-8')
            const { frontmatter, body } = parseFrontmatter(raw)
            const links = extractWikilinks(body)
            entries.push({
              path: relPath,
              title: titleFromPath(relPath),
              tags: frontmatter.tags,
              aliases: frontmatter.aliases,
              links,
              snippet: body.replace(/\n/g, ' ').slice(0, 200),
              updatedAt: frontmatter.updated,
            })
          } catch { /* skip corrupt files */ }
        }
      }
    }
    walk(dir, '')
    await this.setIndex(entries)
    return entries
  }
}
