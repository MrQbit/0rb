/**
 * Memory consolidation ("dream") for the API.
 *
 * The upstream autoDream triggers off filesystem session transcripts +
 * mtime gates — but the API keeps sessions in Redis, so that scan is always
 * empty and the dream never fires. Here we drive the same consolidation on a
 * simple periodic scheduler instead: every ORB2_DREAM_INTERVAL_HOURS, if
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
  const h = Number(process.env.ORB2_DREAM_INTERVAL_HOURS || 6)
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
  // Memory v2: the dream LEARNS from lived days, not just tidies files —
  // recent episodes (real conversation turns) are the raw material.
  let episodeBlock = ''
  try {
    const { recentEpisodes } = await import('./episodes.js')
    const eps = await recentEpisodes(store, 2, 60)
    if (eps.length) {
      episodeBlock = `\nRECENT EPISODES (last 2 days of real conversations — extract durable facts from these):\n`
        + eps.map(e => `- [${e.who}] "${e.text}" → ${e.reply}`).join('\n')
    }
  } catch { /* episodes optional */ }
  const prompt = [
    `Consolidate your long-term memory. Triggered: ${trigger}.`,
    `Your memory files live under ${memoryRoot} (MEMORY.md is the index, plus topic files;`,
    `members/<slug>.md hold PERSONAL facts about each household member).`,
    ``,
    `1. EXTRACT: from the episodes below, save durable NEW facts you don't already have —`,
    `   preferences, routines, people, projects, corrections. Personal facts go to that`,
    `   member's file; household facts to MEMORY.md/topic files. Ignore small talk and`,
    `   one-off requests. A nickname is only recorded if the person asked for it themselves.`,
    `2. DATE facts: stamp new entries with (as of ${new Date().toISOString().slice(0, 7)}). When a new fact`,
    `   CONTRADICTS an old one, don't silently delete — supersede: "X (until ${new Date().toISOString().slice(0, 7)}); now Y".`,
    `3. TIDY: merge duplicates, sharpen vague entries, prune truly dead facts, fix [[links]],`,
    `   keep MEMORY.md a tight one-line-per-memory index. Don't invent facts.`,
    `4. WATCH (SPEC §15): check the Watch tool (op:'list'). If the episodes or your memory show a`,
    `   RECURRING habit worth quietly monitoring for the household (a usual product + typical price,`,
    `   an awaited restock/release, an approaching deadline), register AT MOST ONE new watch via`,
    `   Watch op:'add' — set member to the email of the person it serves, and write the goal with`,
    `   the baseline and the speak-up condition. Skip this step entirely if nothing clearly recurs`,
    `   or a similar watch already exists; a wrong watch is worse than none.`,
    `When done, reply with a one-paragraph summary of what you learned and changed.`,
    episodeBlock,
  ].filter(Boolean).join('\n')

  const summary = await runChannelTurn({
    text: prompt,
    sessionId: `dream:${Date.now()}`,
    ownerId: 'dream',
    store,
    channel: 'dream',      // §17 route class (cloud only if the owner enabled it)
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
      // Auto-dream gate: on unless ORB2_DISABLE_AUTO_DREAM is truthy.
      const dreamDisabled = ['1', 'true', 'yes', 'on'].includes(
        (process.env.ORB2_DISABLE_AUTO_DREAM || '').trim().toLowerCase(),
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
  log.info('dream_scheduler_started', { intervalHours: Number(process.env.ORB2_DREAM_INTERVAL_HOURS || 6) })
}
