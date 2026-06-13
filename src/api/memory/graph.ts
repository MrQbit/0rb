/**
 * Relationship graph memory (Phase 2).
 *
 * Semantic recall (semantic.ts) finds memories by MEANING; this layer adds
 * STRUCTURE — entities (nodes) and the relationships between them (edges) —
 * so the agent can answer relational / multi-hop questions ("who owns Pixel?",
 * "what does the brain run on?") by traversal, not just similarity.
 *
 * Lean + fully local: an LLM extracts (subject, relation, object) triples from
 * the curated memory files; nodes + edges live in Redis (single-user scale, no
 * graph DB needed). Recall finds seed entities for a query and returns their
 * neighbourhood, which RecallMemory blends with the vector hits.
 */
import type { Store } from '../store/store.js'
import { log } from '../log.js'

const NODES_KEY = 'graph:nodes'      // JSON array of node keys
const NODE_PREFIX = 'graph:node:'    // graph:node:<key> -> Node JSON
const EDGES_PREFIX = 'graph:edges:'  // graph:edges:<key> -> Edge[] JSON
const TTL_S = 60 * 60 * 24 * 365

export function graphMemoryEnabled(): boolean {
  return process.env.RAK00N_MEMORY_GRAPH !== '0'
}

export type Triple = { subject: string; relation: string; object: string }
type Edge = { rel: string; target: string; dir: 'out' | 'in' }
type Node = { key: string; name: string; mentions: number }

function norm(s: string): string { return String(s || '').trim().replace(/\s+/g, ' ') }
function keyOf(name: string): string { return norm(name).toLowerCase() }

async function getNodeIndex(store: Store): Promise<string[]> {
  try { const raw = await store.getKv(NODES_KEY); if (raw) return JSON.parse(raw) as string[] } catch { /* */ }
  return []
}
async function setNodeIndex(store: Store, keys: string[]): Promise<void> {
  await store.putKv(NODES_KEY, JSON.stringify(Array.from(new Set(keys))), TTL_S)
}

async function upsertNode(store: Store, name: string): Promise<string> {
  const key = keyOf(name)
  if (!key) return key
  const raw = await store.getKv(NODE_PREFIX + key)
  let node: Node
  try { node = raw ? JSON.parse(raw) as Node : { key, name: norm(name), mentions: 0 } }
  catch { node = { key, name: norm(name), mentions: 0 } }
  node.mentions++
  await store.putKv(NODE_PREFIX + key, JSON.stringify(node), TTL_S)
  const idx = await getNodeIndex(store)
  if (!idx.includes(key)) await setNodeIndex(store, [...idx, key])
  return key
}

async function addEdge(store: Store, fromKey: string, edge: Edge): Promise<void> {
  const raw = await store.getKv(EDGES_PREFIX + fromKey)
  let edges: Edge[] = []
  try { edges = raw ? JSON.parse(raw) as Edge[] : [] } catch { edges = [] }
  if (!edges.some(e => e.rel === edge.rel && e.target === edge.target && e.dir === edge.dir)) {
    edges.push(edge)
    await store.putKv(EDGES_PREFIX + fromKey, JSON.stringify(edges.slice(-100)), TTL_S)
  }
}

/** Store a triple as a node pair + a directed edge (kept both ways for traversal). */
export async function addTriple(store: Store, t: Triple): Promise<void> {
  const sName = norm(t.subject), oName = norm(t.object), rel = norm(t.relation)
  if (!sName || !oName || !rel) return
  const sk = await upsertNode(store, sName)
  const ok = await upsertNode(store, oName)
  await addEdge(store, sk, { rel, target: ok, dir: 'out' })
  await addEdge(store, ok, { rel, target: sk, dir: 'in' })
}

/** Ask the agent to extract entity/relationship triples from text. */
export async function extractTriples(text: string): Promise<Triple[]> {
  const body = text.trim()
  if (!body) return []
  const { runAgentTurn } = await import('../agentRunner.js')
  const message =
    'Extract a knowledge graph from the notes below. Return STRICTLY JSON: ' +
    '{"triples":[{"subject":string,"relation":string,"object":string}]}. ' +
    'subject/object are concrete entities (people, pets, services, projects, tools, hosts, places, preferences). ' +
    'relation is a short snake_case verb phrase (owns, named, runs_on, uses, serves, prefers, located_in, part_of, depends_on, authored). ' +
    'Skip vague, temporary, or meta facts. Max 60 triples.\n\n===NOTES===\n' +
    body.slice(0, 12000) + '\n===END==='
  try {
    const r = await runAgentTurn(
      { message, previousMessages: [], autoApprove: () => true, sessionId: `graph:${Date.now()}`, allowedTools: new Set([]) },
      { onLog: (l, m, d) => (log as any)[l]?.(m, d) },
    )
    const txt = r?.fullText ?? ''
    const m = txt.match(/\{[\s\S]*"triples"[\s\S]*\}/)
    if (!m) return []
    const parsed = JSON.parse(m[0])
    if (!Array.isArray(parsed?.triples)) return []
    return parsed.triples.filter((t: any) => t && t.subject && t.relation && t.object)
  } catch (e) {
    log.warn('graph_extract_failed', { error: (e as Error).message })
    return []
  }
}

/** Wipe the whole graph (used before a full rebuild). */
async function clearGraph(store: Store): Promise<void> {
  for (const k of await getNodeIndex(store)) {
    await store.delKv(NODE_PREFIX + k).catch(() => {})
    await store.delKv(EDGES_PREFIX + k).catch(() => {})
  }
  await setNodeIndex(store, [])
}

/** Rebuild the graph from the curated memory files. Called after each dream. */
export async function rebuildGraphFromMemory(store: Store): Promise<number> {
  if (!graphMemoryEnabled()) return 0
  const { readdirSync, readFileSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { getAutoMemPath } = await import('./memPath.js')
  const root = getAutoMemPath()
  let text = ''
  try {
    const walk = (dir: string): string[] => {
      const out: string[] = []
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        let st: any; try { st = statSync(p) } catch { continue }
        if (st.isDirectory()) { if (name !== 'logs') out.push(...walk(p)) }
        else if (name.endsWith('.md')) out.push(p)
      }
      return out
    }
    for (const f of walk(root)) { try { text += '\n\n' + readFileSync(f, 'utf-8') } catch { /* */ } }
  } catch { return 0 }
  const triples = await extractTriples(text)
  await clearGraph(store)
  for (const t of triples) await addTriple(store, t).catch(() => {})
  log.info('graph_rebuilt', { triples: triples.length })
  return triples.length
}

/** Format a node's edges as readable relationship sentences. */
async function neighbourhood(store: Store, key: string): Promise<string[]> {
  const node = await store.getKv(NODE_PREFIX + key)
  if (!node) return []
  let name = key
  try { name = (JSON.parse(node) as Node).name } catch { /* */ }
  const raw = await store.getKv(EDGES_PREFIX + key)
  let edges: Edge[] = []
  try { edges = raw ? JSON.parse(raw) as Edge[] : [] } catch { edges = [] }
  const out: string[] = []
  for (const e of edges) {
    let tName = e.target
    try { const tr = await store.getKv(NODE_PREFIX + e.target); if (tr) tName = (JSON.parse(tr) as Node).name } catch { /* */ }
    out.push(e.dir === 'out' ? `${name} ${e.rel} ${tName}` : `${tName} ${e.rel} ${name}`)
  }
  return out
}

/**
 * Graph recall: find entities mentioned in the query, return their
 * relationships (1 hop). Seed match is token-overlap against node names —
 * cheap and good enough at single-user scale.
 */
export async function recallGraph(store: Store, query: string, maxSeeds = 4): Promise<string[]> {
  if (!graphMemoryEnabled()) return []
  const keys = await getNodeIndex(store)
  if (!keys.length) return []
  const qTokens = new Set((query.toLowerCase().match(/[a-z0-9]{3,}/g) || []))
  if (!qTokens.size) return []
  const scored: Array<{ key: string; score: number }> = []
  for (const k of keys) {
    const nameTokens = k.match(/[a-z0-9]{3,}/g) || []
    let score = 0
    for (const t of nameTokens) if (qTokens.has(t)) score++
    // Whole-name appearing in the query is a strong signal.
    if (k.length >= 3 && query.toLowerCase().includes(k)) score += 2
    if (score > 0) scored.push({ key: k, score })
  }
  scored.sort((a, b) => b.score - a.score)
  const facts: string[] = []
  const seen = new Set<string>()
  for (const { key } of scored.slice(0, maxSeeds)) {
    for (const f of await neighbourhood(store, key)) {
      if (!seen.has(f)) { seen.add(f); facts.push(f) }
    }
  }
  return facts.slice(0, 12)
}

/** Whole-graph dump for inspection (GET /v1/memory/graph). */
export async function dumpGraph(store: Store): Promise<{ nodes: Node[]; edges: Array<{ from: string; rel: string; to: string }> }> {
  const keys = await getNodeIndex(store)
  const nodes: Node[] = []
  const edges: Array<{ from: string; rel: string; to: string }> = []
  for (const k of keys) {
    const nr = await store.getKv(NODE_PREFIX + k)
    if (nr) { try { nodes.push(JSON.parse(nr) as Node) } catch { /* */ } }
    const er = await store.getKv(EDGES_PREFIX + k)
    if (er) { try { for (const e of JSON.parse(er) as Edge[]) if (e.dir === 'out') edges.push({ from: k, rel: e.rel, to: e.target }) } catch { /* */ } }
  }
  return { nodes, edges }
}
