/**
 * Semantic memory — embedding-based recall that complements the file memory.
 *
 * Memories (and their source) are embedded via the GPU embed service and
 * stored in Redis; recall embeds the query and ranks by cosine similarity
 * (brute-force — fine for a single-user box's hundreds of entries; swap to
 * RediSearch KNN if it ever grows huge). This gives MEANING-based recall
 * (paraphrase-aware) that the flat-file "LLM scans the index" approach can't.
 */
import type { Store } from '../store/store.js'
import { log } from '../log.js'

const INDEX_KEY = 'mem:index'
const VEC_PREFIX = 'mem:vec:'
const TTL_S = 60 * 60 * 24 * 365 // 1y

export function semanticMemoryEnabled(): boolean {
  return !!process.env.ORB2_EMBED_URL
}
function embedUrl(): string {
  return (process.env.ORB2_EMBED_URL || '').replace(/\/+$/, '')
}

type Entry = { id: string; text: string; vector: number[]; meta?: Record<string, unknown>; ts: string }

export async function embedTexts(texts: string[], kind: 'query' | 'document'): Promise<number[][]> {
  if (!texts.length) return []
  const res = await fetch(`${embedUrl()}/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ texts, kind }),
  })
  if (!res.ok) throw new Error(`embed http ${res.status}`)
  return (await res.json() as { vectors: number[][] }).vectors
}

function cosine(a: number[], b: number[]): number {
  // Vectors are L2-normalized by the embed service → dot product = cosine.
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!
  return s
}

async function getIndex(store: Store): Promise<string[]> {
  try { const raw = await store.getKv(INDEX_KEY); if (raw) return JSON.parse(raw) as string[] } catch { /* */ }
  return []
}
async function setIndex(store: Store, ids: string[]): Promise<void> {
  await store.putKv(INDEX_KEY, JSON.stringify(Array.from(new Set(ids))), TTL_S)
}

/** Embed + store one memory entry (id is stable so re-indexing overwrites). */
export async function indexEntry(store: Store, id: string, text: string, meta?: Record<string, unknown>): Promise<void> {
  const clean = text.trim()
  if (!clean) return
  const [vector] = await embedTexts([clean], 'document')
  const entry: Entry = { id, text: clean, vector, meta, ts: new Date().toISOString() }
  await store.putKv(VEC_PREFIX + id, JSON.stringify(entry), TTL_S)
  const idx = await getIndex(store)
  if (!idx.includes(id)) await setIndex(store, [...idx, id])
}

export async function removeEntry(store: Store, id: string): Promise<void> {
  await store.delKv(VEC_PREFIX + id)
  await setIndex(store, (await getIndex(store)).filter(x => x !== id))
}

/** Semantic search: returns the top-k most similar memory entries. */
export async function searchSemantic(
  store: Store, query: string, k = 6, minScore = 0.3,
): Promise<Array<{ id: string; text: string; score: number; meta?: Record<string, unknown> }>> {
  const ids = await getIndex(store)
  if (!ids.length) return []
  const [qv] = await embedTexts([query], 'query')
  const scored: Array<{ id: string; text: string; score: number; meta?: Record<string, unknown> }> = []
  for (const id of ids) {
    const raw = await store.getKv(VEC_PREFIX + id)
    if (!raw) continue
    let e: Entry
    try { e = JSON.parse(raw) as Entry } catch { continue }
    const score = cosine(qv, e.vector)
    if (score >= minScore) scored.push({ id, text: e.text, score, meta: e.meta })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k)
}

export async function countEntries(store: Store): Promise<number> {
  return (await getIndex(store)).length
}

/** Agent tool: semantically recall memories relevant to a query. */
export async function executeRecall(
  args: { query?: string; k?: number },
  ctx: { store: Store },
): Promise<string> {
  if (!semanticMemoryEnabled()) return 'Semantic memory is not configured (ORB2_EMBED_URL unset).'
  const query = (args?.query || '').trim()
  if (!query) return 'Provide a query to recall.'
  let hits: Awaited<ReturnType<typeof searchSemantic>>
  try { hits = await searchSemantic(ctx.store, query, Math.min(args?.k || 6, 12)) }
  catch (e) { return `Recall failed: ${(e as Error).message}` }

  // Blend in the relationship graph (Phase 2): structural facts about entities
  // named in the query, which similarity search alone can miss.
  let related: string[] = []
  try {
    const { recallGraph, graphMemoryEnabled } = await import('./graph.js')
    if (graphMemoryEnabled()) related = await recallGraph(ctx.store, query)
  } catch { /* graph optional */ }

  if (!hits.length && !related.length) return 'No relevant memories found.'
  const parts: string[] = []
  if (hits.length) parts.push(hits.map(h => `• (${h.score.toFixed(2)}${h.meta?.path ? ` ${h.meta.path}` : ''}) ${h.text}`).join('\n'))
  if (related.length) parts.push('Related (graph):\n' + related.map(r => `  - ${r}`).join('\n'))
  return parts.join('\n\n')
}

/**
 * (Re)index the file memory: read every `*.md` under the memory dir, split
 * into reasonably-sized chunks, and embed them. Called after a dream and via
 * POST /v1/memory/reindex. Keeps the vector index in sync with MEMORY.md.
 */
export async function reindexFileMemory(store: Store): Promise<number> {
  if (!semanticMemoryEnabled()) return 0
  const { readdirSync, readFileSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { getAutoMemPath } = await import('./memPath.js')
  const root = getAutoMemPath()
  let files: string[]
  try { files = walkMd(root, readdirSync, statSync, join) } catch { return 0 }

  // Clear previous file-sourced entries (ids prefixed file:) then re-add.
  for (const id of await getIndex(store)) {
    if (id.startsWith('file:')) await removeEntry(store, id).catch(() => {})
  }
  let n = 0
  for (const f of files) {
    let content = ''
    try { content = readFileSync(f, 'utf-8') } catch { continue }
    const rel = f.replace(root, '').replace(/^\/+/, '')
    for (const [i, chunk] of chunkText(content).entries()) {
      await indexEntry(store, `file:${rel}#${i}`, chunk, { source: 'file', path: rel }).catch(() => {})
      n++
    }
  }
  log.info('semantic_reindex', { files: files.length, chunks: n })
  return n
}

function walkMd(dir: string, readdirSync: any, statSync: any, join: any): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    let st: any
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) { if (name !== 'logs') out.push(...walkMd(p, readdirSync, statSync, join)) }
    else if (name.endsWith('.md')) out.push(p)
  }
  return out
}

function chunkText(text: string, maxChars = 700): string[] {
  const paras = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
  const chunks: string[] = []
  let cur = ''
  for (const p of paras) {
    if ((cur + '\n\n' + p).length > maxChars && cur) { chunks.push(cur); cur = p }
    else cur = cur ? cur + '\n\n' + p : p
  }
  if (cur) chunks.push(cur)
  return chunks.length ? chunks : [text.slice(0, maxChars)]
}
