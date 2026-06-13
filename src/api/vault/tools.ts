import type { Store } from '../store/store.js'
import { VaultStore } from './store.js'

let _vaultStore: VaultStore | null = null

export function getVaultStore(store: Store): VaultStore {
  if (!_vaultStore) _vaultStore = new VaultStore(store)
  return _vaultStore
}

// ─── Tool definitions (Anthropic tool_use format) ───

export const VAULT_READ_TOOL_DEF = {
  name: 'VaultRead',
  description: 'Read a note from the knowledge vault. Returns the note content, tags, and linked notes. Use to recall project facts, decisions, patterns, or any previously stored knowledge.',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string' as const,
        description: 'Note path relative to vault root, e.g. "deployment/payments-api.md" or "decisions/tech-stack"',
      },
    },
    required: ['path'],
  },
}

export const VAULT_WRITE_TOOL_DEF = {
  name: 'VaultWrite',
  description: 'Write or update a note in the knowledge vault. Use to save important project facts, decisions, architecture patterns, deployment configs, or any durable knowledge. Use [[wikilinks]] in the body to link to other notes. Notes persist across sessions.',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string' as const,
        description: 'Note path, e.g. "deployment/payments-api.md". Directories are created automatically.',
      },
      content: {
        type: 'string' as const,
        description: 'Markdown body of the note. Use [[Note Title]] to link to other vault notes.',
      },
      tags: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: 'Tags for categorization and search, e.g. ["deployment", "staging", "payments"]',
      },
      aliases: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: 'Alternative names for this note, used in search',
      },
    },
    required: ['path', 'content'],
  },
}

export const VAULT_SEARCH_TOOL_DEF = {
  name: 'VaultSearch',
  description: 'Search the knowledge vault for relevant notes. Returns matching notes ranked by relevance. Use before starting work to find existing knowledge, decisions, and patterns.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string' as const,
        description: 'Search query -- can be keywords, topic names, or questions',
      },
      tags: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: 'Optional tag filter to narrow results',
      },
    },
    required: ['query'],
  },
}

// ─── Tool execution functions ───

export async function executeVaultRead(
  input: { path: string },
  store: Store,
): Promise<{ found: boolean; note?: { path: string; title: string; content: string; tags: string[]; links: string[] } }> {
  const vault = getVaultStore(store)
  const note = await vault.read(input.path)
  if (!note) return { found: false }
  return {
    found: true,
    note: {
      path: note.path,
      title: note.title,
      content: note.content,
      tags: note.frontmatter.tags,
      links: note.links,
    },
  }
}

export async function executeVaultWrite(
  input: { path: string; content: string; tags?: string[]; aliases?: string[] },
  store: Store,
  sessionId?: string,
): Promise<{ path: string; title: string; tags: string[]; links: string[]; isNew: boolean }> {
  const vault = getVaultStore(store)
  const existing = await vault.read(input.path)
  const note = await vault.write(input.path, input.content, {
    tags: input.tags,
    aliases: input.aliases,
    session: sessionId,
    source: 'agent',
  })
  return {
    path: note.path,
    title: note.title,
    tags: note.frontmatter.tags,
    links: note.links,
    isNew: !existing,
  }
}

export async function executeVaultSearch(
  input: { query: string; tags?: string[] },
  store: Store,
): Promise<{ results: { path: string; title: string; tags: string[]; snippet: string; score: number }[] }> {
  const vault = getVaultStore(store)
  const results = await vault.search(input.query, input.tags)
  return { results }
}
