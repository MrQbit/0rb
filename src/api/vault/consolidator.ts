/**
 * Multi-session memory consolidation for the API layer.
 *
 * Periodically reviews vault notes from recent sessions and consolidates
 * them: merging duplicates, pruning stale facts, resolving contradictions,
 * and organizing knowledge. This is the API equivalent of the CLI's
 * autoDream system.
 *
 * Triggered manually via POST /v1/vault/consolidate or could be scheduled.
 */
import { randomUUID } from 'node:crypto'
import { runAgentTurn } from '../agentRunner.js'
import type { Store } from '../store/store.js'
import { VaultStore } from './store.js'

const CONSOLIDATION_LOCK_KEY = 'vault:consolidate:lock'
const CONSOLIDATION_STATE_KEY = 'vault:consolidate:state'
const LOCK_TTL = 300 // 5 minutes max
const MIN_HOURS_BETWEEN = 4
const MIN_NOTES_FOR_CONSOLIDATION = 3

type ConsolidationState = {
  lastRunAt: string
  notesAtLastRun: number
  notesMerged: number
  notesPruned: number
}

async function getState(store: Store): Promise<ConsolidationState | null> {
  const raw = await store.getKv(CONSOLIDATION_STATE_KEY)
  return raw ? JSON.parse(raw) : null
}

async function setState(store: Store, state: ConsolidationState): Promise<void> {
  await store.putKv(CONSOLIDATION_STATE_KEY, JSON.stringify(state), 0)
}

function buildConsolidationPrompt(noteSummaries: string, noteCount: number): string {
  return `# Memory Consolidation (Dream)

You are performing a memory consolidation pass over the knowledge vault. Your goal is to synthesize, organize, and clean up the stored knowledge so future sessions can orient quickly.

## Current vault (${noteCount} notes)

${noteSummaries}

## Instructions

### Phase 1 — Review
Use VaultSearch to find related notes. Read key notes with VaultRead to understand their content.

### Phase 2 — Consolidate
For each group of related notes:
- **Merge** near-duplicates into a single comprehensive note
- **Update** notes with stale or contradicted information
- **Add [[wikilinks]]** between related notes that aren't linked yet
- **Improve tags** for better searchability

### Phase 3 — Prune
- Remove or merge notes that overlap significantly
- Convert relative dates ("yesterday", "last week") to absolute dates
- Fix any contradictions between notes

### Phase 4 — Organize
- Ensure consistent tag taxonomy across notes
- Add any missing cross-references via [[wikilinks]]

## Tools available
- VaultSearch: find notes by keyword/tag
- VaultRead: read a note's full content
- VaultWrite: create or update a note

Report what you consolidated, updated, or pruned. If the vault is already well-organized, say so.`
}

export type ConsolidationResult = {
  ran: boolean
  reason?: string
  notesReviewed: number
  duration?: number
}

export async function shouldConsolidate(store: Store): Promise<{ should: boolean; reason: string }> {
  const vault = new VaultStore(store)
  const notes = await vault.list()

  if (notes.length < MIN_NOTES_FOR_CONSOLIDATION) {
    return { should: false, reason: `Only ${notes.length} notes, need at least ${MIN_NOTES_FOR_CONSOLIDATION}` }
  }

  const state = await getState(store)
  if (state) {
    const hoursSince = (Date.now() - new Date(state.lastRunAt).getTime()) / 3_600_000
    if (hoursSince < MIN_HOURS_BETWEEN) {
      return { should: false, reason: `Only ${hoursSince.toFixed(1)}h since last consolidation, need ${MIN_HOURS_BETWEEN}h` }
    }
    if (notes.length <= state.notesAtLastRun) {
      return { should: false, reason: `No new notes since last consolidation (${state.notesAtLastRun} then, ${notes.length} now)` }
    }
  }

  return { should: true, reason: `${notes.length} notes, ready for consolidation` }
}

export async function runConsolidation(
  store: Store,
  opts?: { force?: boolean; model?: string },
): Promise<ConsolidationResult> {
  if (!opts?.force) {
    const check = await shouldConsolidate(store)
    if (!check.should) {
      return { ran: false, reason: check.reason, notesReviewed: 0 }
    }
  }

  // Acquire lock
  const existing = await store.getKv(CONSOLIDATION_LOCK_KEY)
  if (existing) {
    return { ran: false, reason: 'Another consolidation is in progress', notesReviewed: 0 }
  }
  await store.putKv(CONSOLIDATION_LOCK_KEY, Date.now().toString(), LOCK_TTL)

  const startTime = Date.now()

  try {
    const vault = new VaultStore(store)
    const notes = await vault.list()

    const noteSummaries = notes.map(n =>
      `- **${n.path}** [${n.tags.join(', ')}] (updated: ${n.updatedAt})\n  ${n.snippet}`
    ).join('\n')

    const prompt = buildConsolidationPrompt(noteSummaries, notes.length)

    console.log(`[consolidator] Starting consolidation: ${notes.length} notes to review`)

    await runAgentTurn(
      {
        message: prompt,
        model: opts?.model || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-6',
        workingDirectory: '/tmp',
        signal: AbortSignal.timeout(120_000),
        autoApprove: () => true,
      },
      {
        onLog: (level, msg, data) => {
          if (level === 'error') console.error(`[consolidator] ${msg}`, data)
        },
      },
    )

    const duration = Date.now() - startTime
    const updatedNotes = await vault.list()

    await setState(store, {
      lastRunAt: new Date().toISOString(),
      notesAtLastRun: updatedNotes.length,
      notesMerged: 0, // tracked by vault writes
      notesPruned: Math.max(0, notes.length - updatedNotes.length),
    })

    console.log(`[consolidator] Consolidation complete: ${notes.length} -> ${updatedNotes.length} notes, ${duration}ms`)

    return {
      ran: true,
      notesReviewed: notes.length,
      duration,
    }
  } catch (err) {
    console.error(`[consolidator] Consolidation failed:`, (err as Error).message)
    return { ran: false, reason: (err as Error).message, notesReviewed: 0 }
  } finally {
    await store.delKv(CONSOLIDATION_LOCK_KEY)
  }
}
