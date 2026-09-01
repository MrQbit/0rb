/**
 * The hybrid brain (SPEC §17) — sovereign by default, frontier on demand.
 *
 * Local is the default, always. A turn may run on a cloud model ONLY when
 * its route CLASS is explicitly enabled by the owner, a key is configured,
 * the master switch is on, and the monthly budget has room. Voice and
 * anything carrying an image never route, categorically.
 *
 * Classes (per-class toggles, Settings → "What leaves the box"):
 *   deep-chat      — the user asked to think hard ("think hard/deeply")
 *   planning       — long-form design/architecture/strategy turns
 *   watch-research — §15 standing-intent worker turns
 *   dream          — nightly memory consolidation (sends episode summaries
 *                    and memory notes BY DESIGN — that's its whole job, and
 *                    the Settings card says so in plain language)
 *
 * The privacy firewall rides the decision: for every cloud class except
 * `dream`, the caller must OMIT the household context block (recall,
 * family details) — enforced at the two turn-assembly sites via
 * `firewallContext()`. Every cloud turn is journaled (ambient) and its
 * estimated cost accrues against a monthly cap; over cap → local, silently.
 */
import type { Store } from '../store/store.js'

const CONFIG_KEY = 'brain:config'
const SPEND_KEY = (ym: string) => `brain:spend:${ym}`

export type BrainClass = 'deep-chat' | 'planning' | 'watch-research' | 'dream'

export interface BrainConfig {
  enabled: boolean                      // master kill-switch (false = 100% local)
  classes: Record<BrainClass, boolean>
  monthly_cap_cents: number
  model: string                         // '' = provider default
}

export const DEFAULT_CONFIG: BrainConfig = {
  enabled: false,
  classes: { 'deep-chat': true, planning: false, 'watch-research': false, dream: false },
  monthly_cap_cents: 2000,
  model: '',
}

export async function getBrainConfig(store: Store): Promise<BrainConfig> {
  try {
    const raw = await store.getKv(CONFIG_KEY)
    if (raw) {
      const c = JSON.parse(raw)
      return { ...DEFAULT_CONFIG, ...c, classes: { ...DEFAULT_CONFIG.classes, ...(c.classes || {}) } }
    }
  } catch { /* default */ }
  return { ...DEFAULT_CONFIG, classes: { ...DEFAULT_CONFIG.classes } }
}

export async function setBrainConfig(store: Store, patch: Partial<BrainConfig>): Promise<BrainConfig> {
  const cur = await getBrainConfig(store)
  const next: BrainConfig = {
    enabled: patch.enabled ?? cur.enabled,
    classes: { ...cur.classes, ...(patch.classes || {}) },
    monthly_cap_cents: Math.max(0, Math.min(100_000, patch.monthly_cap_cents ?? cur.monthly_cap_cents)),
    model: (patch.model ?? cur.model).trim(),
  }
  await store.putKv(CONFIG_KEY, JSON.stringify(next), 60 * 60 * 24 * 365 * 5)
  return next
}

function ym(now = new Date()): string { return now.toISOString().slice(0, 7) }

export async function getMonthSpendCents(store: Store): Promise<number> {
  return Number((await store.getKv(SPEND_KEY(ym())).catch(() => '0')) || '0')
}

/** Provider resolution: direct Anthropic if keyed, else OpenRouter. */
export function cloudProvider(model: string): { model: string; baseURL: string; apiKey: string } | null {
  const anth = (process.env.ORB2_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY || '').trim()
  if (anth) return { model: model || 'claude-sonnet-5', baseURL: 'https://api.anthropic.com/v1', apiKey: anth }
  const or = (process.env.ORB2_OPENROUTER_KEY || '').trim()
  if (or) return { model: model || 'anthropic/claude-sonnet-5', baseURL: 'https://openrouter.ai/api/v1', apiKey: or }
  return null
}

const DEEP = /\b(think (hard|deep|deeply|really hard)|ultrathink|deep dive)\b/i
const PLANNING = /\b(architecture|design (a|the|an)|plan (a|the|an)|spec(ify)? |strateg(y|ize)|trade[- ]?offs?|step[- ]by[- ]step plan|roadmap|proposal)\b/i

export interface TurnMeta { text: string; channel?: string; hasImage?: boolean }
export interface BrainDecision { provider: { model: string; baseURL: string; apiKey: string }; class: BrainClass }

/** Classify the turn — independent of whether routing is enabled. */
export function classifyTurn(input: TurnMeta): BrainClass | null {
  if (input.channel === 'voice') return null            // latency: local, always
  if (input.hasImage) return null                       // firewall: frames never leave
  if (input.channel === 'dream') return 'dream'
  if (input.channel === 'intent') return 'watch-research'
  const t = input.text || ''
  if (DEEP.test(t)) return 'deep-chat'
  if (PLANNING.test(t) || t.length > 1200) return 'planning'
  return null
}

/** The route decision for one turn: cloud {provider, class} or null = local. */
export async function decideTurn(store: Store, input: TurnMeta): Promise<BrainDecision | null> {
  const cls = classifyTurn(input)
  if (!cls) return null
  const cfg = await getBrainConfig(store)
  if (!cfg.enabled || !cfg.classes[cls]) return null
  const provider = cloudProvider(cfg.model)
  if (!provider) return null
  if ((await getMonthSpendCents(store)) >= cfg.monthly_cap_cents) return null   // over cap → local
  return { provider, class: cls }
}

/**
 * Firewall: the household-context block a cloud turn may carry.
 * `dream` keeps it (memory work IS its context); every other class sends
 * the task alone. Returns whether context is allowed.
 */
export function firewallAllowsContext(cls: BrainClass): boolean {
  return cls === 'dream'
}

/** Rough cost estimate (Sonnet-class pricing) — for the cap, not billing. */
export function estimateCents(charsIn: number, charsOut: number): number {
  const tin = charsIn / 4, tout = charsOut / 4
  return tin * 0.0003 + tout * 0.0015
}

/** Journal + meter one completed cloud turn (the receipt for §17.3). */
export async function recordCloudUse(store: Store, cls: BrainClass, model: string, charsIn: number, charsOut: number): Promise<void> {
  const cents = estimateCents(charsIn, charsOut)
  const key = SPEND_KEY(ym())
  const cur = Number((await store.getKv(key).catch(() => '0')) || '0')
  await store.putKv(key, String(cur + cents), 60 * 86400).catch(() => {})
  try {
    const { logEvent } = await import('../events/journal.js')
    await logEvent(store, {
      kind: 'note', attention: 'ambient',
      summary: `☁ cloud turn (${cls}, ${model}) — ~$${(cents / 100).toFixed(3)}, month total $${((cur + cents) / 100).toFixed(2)}`,
    })
  } catch { /* metering only */ }
}
