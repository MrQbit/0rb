/**
 * Automatic recall (memory v2): every substantive turn gets the memories
 * that are semantically relevant to what was just said — WITHOUT the model
 * having to think of calling RecallMemory. Injected as background context;
 * usage is counted so often-recalled memories rank up over time (salience).
 */
import type { Store } from '../store/store.js'

const HITS_KEY = 'mem:hits'
const MIN_SCORE = 0.42     // cosine floor — below this, matches read as noise
const MAX_ITEMS = 4

async function hits(store: Store): Promise<Record<string, number>> {
  try { return JSON.parse((await store.getKv(HITS_KEY)) || '{}') } catch { return {} }
}

export async function recallBlock(store: Store, text: string): Promise<string> {
  try {
    const { semanticMemoryEnabled, searchSemantic } = await import('./semantic.js')
    if (!semanticMemoryEnabled()) return ''
    const q = text.trim()
    if (q.length < 12) return ''    // greetings/acks don't warrant a search
    const found = await searchSemantic(store, q, 8, MIN_SCORE)
    if (!found.length) return ''
    // Salience: frequently-useful memories win close calls.
    const h = await hits(store)
    found.sort((a, b) => (b.score + Math.min(h[b.id] ?? 0, 10) * 0.005) - (a.score + Math.min(h[a.id] ?? 0, 10) * 0.005))
    const top = found.slice(0, MAX_ITEMS)
    for (const t of top) h[t.id] = (h[t.id] ?? 0) + 1
    // cap the hits map so it can't grow unbounded
    const entries = Object.entries(h).sort((a, b) => b[1] - a[1]).slice(0, 400)
    await store.putKv(HITS_KEY, JSON.stringify(Object.fromEntries(entries)), 0).catch(() => {})
    return '\nAUTO-RECALLED MEMORY (semantically matched to this message — background context, may be stale; prefer current tool state for live facts):\n'
      + top.map(t => `- ${t.text.replace(/\s+/g, ' ').slice(0, 260)}`).join('\n')
  } catch { return '' }
}
