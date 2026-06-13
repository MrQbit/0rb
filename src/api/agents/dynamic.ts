/**
 * Dynamic sub-agent definitions registered at runtime via the
 * /v1/agents API surface. Two backing stores are kept in sync:
 *
 *   1. Redis -- orb2:agent:def:<id>             individual entries
 *               orb2:agent:def:index             set of known ids
 *   2. Filesystem mirror -- <FS_ROOT>/<id>.md   markdown frontmatter,
 *      so an operator inspecting the discovery cache (or an EMU
 *      repo committed back to git) gets a human-readable artifact.
 *
 * When ORB2_AGENT_FS_ROOT is unset, only Redis is used.
 *
 * Conflict policy: dynamic agents never override built-ins -- the
 * server merges them after the logical-agent list at consumption
 * time, so a duplicate id surfaces both.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Store } from '../store/store.js'

const REDIS_INDEX_KEY = 'orb2:agent:def:index'
const REDIS_PREFIX = 'orb2:agent:def:'

async function readIndex(store: Store): Promise<string[]> {
  const raw = await store.getKv(REDIS_INDEX_KEY)
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []
  } catch { return [] }
}

async function writeIndex(store: Store, ids: string[]): Promise<void> {
  const uniq = Array.from(new Set(ids))
  await store.putKv(REDIS_INDEX_KEY, JSON.stringify(uniq), 0)
}

async function indexAdd(store: Store, id: string): Promise<void> {
  const ids = await readIndex(store)
  if (!ids.includes(id)) {
    ids.push(id)
    await writeIndex(store, ids)
  }
}

async function indexRemove(store: Store, id: string): Promise<void> {
  const ids = await readIndex(store)
  const next = ids.filter(x => x !== id)
  if (next.length !== ids.length) await writeIndex(store, next)
}
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$/

export type DynamicAgent = {
  id: string
  name: string
  description: string
  prompt: string
  tools?: string[]
  model?: string
  /** Whether the entry is mirrored to the filesystem. */
  persisted: boolean
  created_at: string
  created_by?: string
}

export type DynamicAgentInput = {
  id?: string
  name: string
  description: string
  prompt: string
  tools?: string[]
  model?: string
  /** When true and FS_ROOT configured, mirror to disk. */
  persist?: boolean
}

function fsRoot(): string | undefined {
  const v = process.env.ORB2_AGENT_FS_ROOT
  return v && v.trim().length > 0 ? v.trim() : undefined
}

export function isValidAgentId(id: string): boolean {
  return ID_PATTERN.test(id)
}

function fsPathFor(id: string): string | undefined {
  const root = fsRoot()
  if (!root) return undefined
  return join(root, `${id}.md`)
}

function renderMarkdown(a: DynamicAgent): string {
  const lines = ['---']
  lines.push(`name: ${JSON.stringify(a.name)}`)
  lines.push(`description: ${JSON.stringify(a.description)}`)
  if (a.tools && a.tools.length > 0) {
    lines.push(`tools: [${a.tools.map(t => JSON.stringify(t)).join(', ')}]`)
  }
  if (a.model) lines.push(`model: ${JSON.stringify(a.model)}`)
  lines.push(`created_at: ${a.created_at}`)
  if (a.created_by) lines.push(`created_by: ${JSON.stringify(a.created_by)}`)
  lines.push('---')
  lines.push('')
  lines.push(a.prompt.trim())
  return lines.join('\n') + '\n'
}

export async function listDynamicAgents(store: Store): Promise<DynamicAgent[]> {
  const ids = await readIndex(store)
  const out: DynamicAgent[] = []
  for (const id of ids) {
    const raw = await store.getKv(`${REDIS_PREFIX}${id}`)
    if (!raw) continue
    try { out.push(JSON.parse(raw) as DynamicAgent) } catch { /* skip */ }
  }
  return out
}

export async function getDynamicAgent(store: Store, id: string): Promise<DynamicAgent | null> {
  if (!isValidAgentId(id)) return null
  const raw = await store.getKv(`${REDIS_PREFIX}${id}`)
  if (!raw) return null
  try { return JSON.parse(raw) as DynamicAgent } catch { return null }
}

export async function createDynamicAgent(
  store: Store,
  input: DynamicAgentInput,
  createdBy?: string,
): Promise<DynamicAgent> {
  const id = (input.id ?? input.name).toLowerCase().replace(/\s+/g, '-')
  if (!isValidAgentId(id)) {
    throw new Error(`Invalid agent id "${id}"; must match ${ID_PATTERN}`)
  }
  if (!input.name?.trim()) throw new Error('name is required')
  if (!input.description?.trim()) throw new Error('description is required')
  if (!input.prompt?.trim()) throw new Error('prompt is required')

  const persistRequested = !!input.persist
  const fsPath = persistRequested ? fsPathFor(id) : undefined
  const persisted = !!fsPath

  const agent: DynamicAgent = {
    id,
    name: input.name.trim(),
    description: input.description.trim(),
    prompt: input.prompt,
    tools: input.tools,
    model: input.model,
    persisted,
    created_at: new Date().toISOString(),
    created_by: createdBy,
  }

  await store.putKv(`${REDIS_PREFIX}${id}`, JSON.stringify(agent), 0)
  await indexAdd(store, id)

  if (fsPath) {
    try {
      const root = fsRoot()!
      mkdirSync(root, { recursive: true })
      writeFileSync(fsPath, renderMarkdown(agent), 'utf-8')
    } catch (err) {
      // FS mirror is best-effort; Redis stays authoritative.
      console.warn('[dynamic-agent] fs mirror failed:', (err as Error).message)
    }
  }

  return agent
}

export async function deleteDynamicAgent(store: Store, id: string): Promise<boolean> {
  if (!isValidAgentId(id)) return false
  const existed = await store.getKv(`${REDIS_PREFIX}${id}`)
  await store.delKv(`${REDIS_PREFIX}${id}`)
  await indexRemove(store, id)
  const fsPath = fsPathFor(id)
  if (fsPath && existsSync(fsPath)) {
    try { unlinkSync(fsPath) } catch { /* best effort */ }
  }
  return !!existed
}

/** Read any FS-rooted definitions on cold start so a fresh Redis can re-index. */
export async function reconcileFsAgents(store: Store): Promise<number> {
  const root = fsRoot()
  if (!root || !existsSync(root)) return 0
  const { readdirSync } = await import('node:fs')
  let n = 0
  for (const fname of readdirSync(root)) {
    if (!fname.endsWith('.md')) continue
    const id = fname.slice(0, -3)
    if (!isValidAgentId(id)) continue
    const inRedis = await store.getKv(`${REDIS_PREFIX}${id}`)
    if (inRedis) continue
    try {
      const raw = readFileSync(join(root, fname), 'utf-8')
      const agent = parseFsAgent(id, raw)
      if (!agent) continue
      await store.putKv(`${REDIS_PREFIX}${id}`, JSON.stringify(agent), 0)
      await indexAdd(store, id)
      n++
    } catch { /* skip bad file */ }
  }
  return n
}

function parseFsAgent(id: string, raw: string): DynamicAgent | null {
  if (!raw.startsWith('---')) return null
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return null
  const head = raw.slice(3, end)
  const body = raw.slice(end + 4).replace(/^\r?\n/, '')
  const fm: Record<string, string> = {}
  for (const line of head.split('\n')) {
    const m = line.trim().match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/)
    if (m) fm[m[1]!.trim()] = m[2]!.trim().replace(/^["']|["']$/g, '')
  }
  if (!fm.name || !fm.description) return null
  let tools: string[] | undefined
  if (fm.tools) {
    const inner = fm.tools.replace(/^\[|\]$/g, '')
    tools = inner.split(',').map(t => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    if (tools.length === 0) tools = undefined
  }
  return {
    id,
    name: fm.name,
    description: fm.description,
    prompt: body.trim(),
    tools,
    model: fm.model || undefined,
    persisted: true,
    created_at: fm.created_at || new Date().toISOString(),
    created_by: fm.created_by || undefined,
  }
}
