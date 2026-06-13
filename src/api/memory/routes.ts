/**
 * Memory expansion endpoints. The TUI has rich memory features
 * (auto-extract, scan, dream, vault notes); for the API we expose
 * the storage-layer operations that don't require TUI context:
 *
 *   GET  /v1/sessions/:id/memory   list memory entries for a session
 *   POST /v1/sessions/:id/memory   append a memory entry
 *   POST /v1/extract-memories      ask the agent to extract memories from messages
 *   POST /v1/memory/search         search across memory entries (q, tags)
 */
import type { Store } from '../store/store.js'
import type { CallerIdentity } from '../auth/context.js'
import { runAgentTurn } from '../agentRunner.js'
import { log } from '../log.js'
import { randomUUID } from 'node:crypto'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = await req.json()
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const MEM_KEY_PREFIX = 'orb2:memory:session:'
const MEM_INDEX_KEY = 'orb2:memory:index'

type MemoryEntry = {
  id: string
  session_id: string
  content: string
  tags: string[]
  recorded_at: string
  source: 'manual' | 'agent' | 'worker'
}

async function listSessionMemory(store: Store, sessionId: string): Promise<MemoryEntry[]> {
  const raw = await store.getKv(MEM_KEY_PREFIX + sessionId)
  if (!raw) return []
  try { return JSON.parse(raw) as MemoryEntry[] } catch { return [] }
}

async function writeSessionMemory(store: Store, sessionId: string, entries: MemoryEntry[]): Promise<void> {
  await store.putKv(MEM_KEY_PREFIX + sessionId, JSON.stringify(entries.slice(-200)), 86400 * 30)
  // Append session id to global index for discovery.
  const idxRaw = await store.getKv(MEM_INDEX_KEY)
  let idx: string[] = []
  try { idx = idxRaw ? JSON.parse(idxRaw) : [] } catch { idx = [] }
  if (!idx.includes(sessionId)) {
    idx.push(sessionId)
    await store.putKv(MEM_INDEX_KEY, JSON.stringify(idx.slice(-500)), 86400 * 30)
  }
}

export async function tryHandleMemoryRoute(
  req: Request,
  pathname: string,
  identity: CallerIdentity,
  ctx: { store: Store },
): Promise<Response | null> {
  const method = req.method

  // GET /v1/sessions/:id/memory
  const sesMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/memory$/)
  if (sesMatch && (method === 'GET' || method === 'POST')) {
    const sessionId = sesMatch[1]!
    if (method === 'GET') {
      const entries = await listSessionMemory(ctx.store, sessionId)
      return jsonResponse(200, { session_id: sessionId, entries })
    }
    // POST
    const body = (await readJson(req)) ?? {}
    const content = String(body.content ?? '').trim()
    if (!content) return jsonResponse(400, { error: 'content is required' })
    const tags = Array.isArray(body.tags) ? (body.tags as string[]) : []
    const source: MemoryEntry['source'] =
      identity.type === 'service' ? 'worker' : 'manual'
    const entry: MemoryEntry = {
      id: randomUUID(),
      session_id: sessionId,
      content,
      tags,
      recorded_at: new Date().toISOString(),
      source,
    }
    const existing = await listSessionMemory(ctx.store, sessionId)
    await writeSessionMemory(ctx.store, sessionId, [...existing, entry])
    return jsonResponse(200, { entry })
  }

  // POST /v1/extract-memories
  if (method === 'POST' && pathname === '/v1/extract-memories') {
    const body = (await readJson(req)) ?? {}
    const sessionId = String(body.session_id ?? '').trim() || randomUUID()
    const messages = Array.isArray(body.messages) ? body.messages : []
    if (messages.length === 0) {
      return jsonResponse(400, { error: 'messages array is required' })
    }
    const transcript = messages
      .map(m => `[${(m as any).role ?? 'unknown'}] ${(m as any).content ?? ''}`)
      .join('\n\n')
    const message =
      'Extract durable memories from the conversation below. Return strictly a ' +
      'JSON array under the field "memories" -- each item: ' +
      '{ "content": string, "tags": string[] }. Keep each item under 200 chars. ' +
      'Skip ephemeral facts (transient errors, build noise). \n\n' +
      `===CONVERSATION===\n${transcript}\n===END===`
    let extracted: { content: string; tags: string[] }[] = []
    try {
      const r = await runAgentTurn(
        {
          message,
          previousMessages: [],
          autoApprove: () => true,
          sessionId,
          allowedTools: new Set([]),
        },
        { onLog: (l, m, d) => log[l]?.(m, d as any) },
      )
      const txt = r?.fullText ?? ''
      const m = txt.match(/\{[\s\S]*"memories"[\s\S]*\}/)
      if (m) {
        const parsed = JSON.parse(m[0])
        if (Array.isArray(parsed?.memories)) extracted = parsed.memories
      }
    } catch (err) {
      return jsonResponse(500, { error: 'extraction failed', message: (err as Error).message })
    }
    if (extracted.length > 0) {
      const entries: MemoryEntry[] = extracted.map(e => ({
        id: randomUUID(),
        session_id: sessionId,
        content: e.content,
        tags: Array.isArray(e.tags) ? e.tags : [],
        recorded_at: new Date().toISOString(),
        source: 'agent',
      }))
      const existing = await listSessionMemory(ctx.store, sessionId)
      await writeSessionMemory(ctx.store, sessionId, [...existing, ...entries])
    }
    return jsonResponse(200, { session_id: sessionId, extracted })
  }

  // POST /v1/memory/search
  if (method === 'POST' && pathname === '/v1/memory/search') {
    const body = (await readJson(req)) ?? {}
    const q = String(body.q ?? body.query ?? '').toLowerCase().trim()
    const tags = Array.isArray(body.tags) ? (body.tags as string[]) : []
    const limit = typeof body.limit === 'number' ? body.limit : 50
    // Search across all sessions in the index. Linear scan -- fine for
    // the volumes we expect (hundreds-thousands of entries).
    const idxRaw = await ctx.store.getKv(MEM_INDEX_KEY)
    let sessions: string[] = []
    try { sessions = idxRaw ? JSON.parse(idxRaw) : [] } catch { sessions = [] }
    const out: (MemoryEntry & { score: number })[] = []
    for (const sid of sessions) {
      const entries = await listSessionMemory(ctx.store, sid)
      for (const e of entries) {
        let score = 0
        if (q) {
          const hay = (e.content + ' ' + e.tags.join(' ')).toLowerCase()
          if (hay.includes(q)) score += 10
        }
        if (tags.length > 0) {
          const inter = e.tags.filter(t => tags.includes(t)).length
          if (inter > 0) score += inter * 5
          else if (q === '') continue // tag-only search; skip non-matches
        }
        if (q === '' && tags.length === 0) score = 1
        if (score > 0) out.push({ ...e, score })
      }
    }
    out.sort((a, b) => b.score - a.score)
    return jsonResponse(200, { results: out.slice(0, limit) })
  }

  // POST /v1/memory/dream — force a memory consolidation ("dream") now.
  // Runs the same consolidation the autoDream scheduler runs on a timer:
  // the agent greps recent session transcripts and synthesizes durable
  // memories into /memory/MEMORY.md + typed files.
  if (method === 'POST' && pathname === '/v1/memory/dream') {
    const { getAutoMemPath, isAutoMemoryEnabled } = await import('./memPath.js')
    if (!isAutoMemoryEnabled()) return jsonResponse(400, { error: 'auto-memory is disabled' })
    const { runDreamConsolidation } = await import('./dream.js')
    try {
      const summary = await runDreamConsolidation(ctx.store, 'manual')
      return jsonResponse(200, {
        ok: true,
        memory_root: getAutoMemPath(),
        summary: summary.slice(0, 4000),
      })
    } catch (err) {
      log.error('memory_dream_failed', { error: (err as Error).message })
      return jsonResponse(500, { error: (err as Error).message })
    }
  }

  // POST /v1/memory/reindex — rebuild the semantic (vector) index from the
  // memory files. Also runs after each dream.
  if (method === 'POST' && pathname === '/v1/memory/reindex') {
    const { reindexFileMemory, semanticMemoryEnabled } = await import('./semantic.js')
    if (!semanticMemoryEnabled()) return jsonResponse(400, { error: 'semantic memory disabled (ORB2_EMBED_URL unset)' })
    const chunks = await reindexFileMemory(ctx.store)
    return jsonResponse(200, { ok: true, chunks })
  }

  // GET /v1/memory/recall?q=... — semantic recall (for testing/inspection).
  if (method === 'GET' && pathname === '/v1/memory/recall') {
    const { searchSemantic, semanticMemoryEnabled } = await import('./semantic.js')
    if (!semanticMemoryEnabled()) return jsonResponse(400, { error: 'semantic memory disabled' })
    const q = new URL(req.url).searchParams.get('q') || ''
    if (!q) return jsonResponse(400, { error: 'q required' })
    return jsonResponse(200, { results: await searchSemantic(ctx.store, q, 8) })
  }

  // POST /v1/memory/graph/rebuild — extract entities/relationships from the
  // memory files into the relationship graph (Phase 2). Also runs after a dream.
  if (method === 'POST' && pathname === '/v1/memory/graph/rebuild') {
    const { rebuildGraphFromMemory, graphMemoryEnabled } = await import('./graph.js')
    if (!graphMemoryEnabled()) return jsonResponse(400, { error: 'graph memory disabled (ORB2_MEMORY_GRAPH=0)' })
    const triples = await rebuildGraphFromMemory(ctx.store)
    return jsonResponse(200, { ok: true, triples })
  }

  // GET /v1/memory/graph — dump the relationship graph (inspection).
  // GET /v1/memory/graph?q=... — graph recall for a query (seed + 1 hop).
  if (method === 'GET' && pathname === '/v1/memory/graph') {
    const { dumpGraph, recallGraph, graphMemoryEnabled } = await import('./graph.js')
    if (!graphMemoryEnabled()) return jsonResponse(400, { error: 'graph memory disabled' })
    const q = new URL(req.url).searchParams.get('q')
    if (q) return jsonResponse(200, { facts: await recallGraph(ctx.store, q) })
    return jsonResponse(200, await dumpGraph(ctx.store))
  }

  return null
}
