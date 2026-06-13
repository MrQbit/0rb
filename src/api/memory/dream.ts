/**
 * Memory consolidation ("dream") for the API.
 *
 * The upstream autoDream triggers off filesystem session transcripts +
 * mtime gates — but the API keeps sessions in Redis, so that scan is always
 * empty and the dream never fires. Here we drive the same consolidation on a
 * simple periodic scheduler instead: every RAK00N_DREAM_INTERVAL_HOURS, if
 * auto-memory is enabled, run a consolidation agent turn that reviews and
 * organizes /memory, then refresh the semantic index.
 *
 * Manual trigger: POST /v1/memory/dream (uses runDreamConsolidation too).
 */
import type { Store } from '../store/store.js'
import { log } from '../log.js'

const LAST_DREAM_KEY = 'memory:last_dream_at'

let scheduler: ReturnType<typeof setInterval> | null = null
let running = false

function intervalMs(): number {
  const h = Number(process.env.RAK00N_DREAM_INTERVAL_HOURS || 6)
  return Math.max(0.05, h) * 3_600_000
}

/**
 * Run one consolidation. Returns the agent's summary. `trigger` is recorded
 * in the prompt so the agent knows whether it was manual or scheduled.
 */
export async function runDreamConsolidation(store: Store, trigger: 'manual' | 'scheduled'): Promise<string> {
  const { getAutoMemPath, isAutoMemoryEnabled } = await import('./memPath.js')
  if (!isAutoMemoryEnabled()) return 'auto-memory disabled'
  const { runChannelTurn } = await import('../channels/runtime.js')

  // Self-contained consolidation prompt (was core's buildConsolidationPrompt +
  // session-transcript scan, which the API doesn't keep on disk).
  const memoryRoot = getAutoMemPath()
  const prompt = [
    `Consolidate your long-term memory. Triggered: ${trigger}.`,
    `Your memory files live under ${memoryRoot} (MEMORY.md is the index, plus topic files).`,
    `Use your Read/Write/Edit tools to: merge duplicates, sharpen vague entries, prune anything`,
    `stale or contradictory, fix broken [[links]], and make sure MEMORY.md is an accurate,`,
    `tight index with one line per memory. Don't invent facts — only reorganize what's there.`,
    `When done, reply with a one-paragraph summary of what you changed.`,
  ].join('\n')

  const summary = await runChannelTurn({
    text: prompt,
    sessionId: `dream:${Date.now()}`,
    ownerId: 'dream',
    store,
  })
  await store.putKv(LAST_DREAM_KEY, String(Date.now()), 60 * 60 * 24 * 365).catch(() => {})
  // Refresh the semantic index + the relationship graph from the (possibly
  // updated) memory files.
  try {
    const { reindexFileMemory } = await import('./semantic.js')
    await reindexFileMemory(store)
  } catch { /* ignore */ }
  try {
    const { rebuildGraphFromMemory } = await import('./graph.js')
    await rebuildGraphFromMemory(store)
  } catch { /* ignore */ }
  return summary
}

/** Start the periodic dream loop. Idempotent. */
export function startDreamScheduler(store: Store): void {
  if (scheduler) return
  const tick = async () => {
    if (running) return
    running = true
    try {
      const { isAutoMemoryEnabled } = await import('./memPath.js')
      // Auto-dream gate: on unless RAK00N_DISABLE_AUTO_DREAM is truthy.
      const dreamDisabled = ['1', 'true', 'yes', 'on'].includes(
        (process.env.RAK00N_DISABLE_AUTO_DREAM || '').trim().toLowerCase(),
      )
      if (isAutoMemoryEnabled() && !dreamDisabled) {
        log.info('dream_scheduled_start')
        const s = await runDreamConsolidation(store, 'scheduled')
        log.info('dream_scheduled_done', { summary: s.slice(0, 160) })
      }
    } catch (err) {
      log.warn('dream_scheduled_error', { error: (err as Error).message })
    } finally {
      running = false
    }
  }
  scheduler = setInterval(() => void tick(), intervalMs())
  if (typeof (scheduler as any).unref === 'function') (scheduler as any).unref()
  log.info('dream_scheduler_started', { intervalHours: Number(process.env.RAK00N_DREAM_INTERVAL_HOURS || 6) })
}
