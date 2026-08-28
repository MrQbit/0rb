/**
 * Budget & spend policy engine (SPEC §1): money enters the SAME trust
 * gradient as door locks. One choke point — authorizeSpend — decides
 * auto / ask / refused for every cart before it is finalized, from
 * owner-set per-category tiers, weekly hard caps, earned auto-tiers
 * (mirroring action autonomy), and the member's own profile.
 *
 * Spend receipts extend the ordinary receipts ring with amount/category/
 * refund-path — where money moved, Undo never lies: it opens the refund
 * path instead of claiming reversal.
 */
import type { Store } from '../store/store.js'
import { log } from '../log.js'

export type SpendCategory = 'food' | 'rides' | 'consumables' | 'gifts' | 'other'
export const SPEND_CATEGORIES: SpendCategory[] = ['food', 'rides', 'consumables', 'gifts', 'other']

export interface CategoryPolicy {
  askUnder: number          // cents — below this an EARNED tier may auto
  neverOver: number         // cents — above this always refused (owner raises it in Settings)
  tier: 'ask' | 'earned' | 'never'
}
export interface SpendPolicy {
  categories: Record<SpendCategory, CategoryPolicy>
  weeklyCapCents: number
  currency: string
}

const POLICY_KEY = 'spend:policy'
const WEEK_KEY = (w: string) => `spend:week:${w}`
const EARNED_KEY = (c: string) => `spend:earned:${c}`
export const EARN_AT = 3            // approvals in a row before auto is offered

export const DEFAULT_POLICY: SpendPolicy = {
  categories: {
    food: { askUnder: 6000, neverOver: 12000, tier: 'ask' },
    rides: { askUnder: 3000, neverOver: 10000, tier: 'ask' },
    consumables: { askUnder: 3000, neverOver: 8000, tier: 'ask' },
    gifts: { askUnder: 0, neverOver: 20000, tier: 'ask' },   // gifts NEVER earn auto
    other: { askUnder: 2000, neverOver: 10000, tier: 'ask' },
  },
  weeklyCapCents: 40000,
  currency: 'USD',
}

export function isoWeek(d = new Date()): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const y = t.getUTCFullYear()
  const week = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7)
  return `${y}-W${String(week).padStart(2, '0')}`
}

export async function getSpendPolicy(store: Store): Promise<SpendPolicy> {
  try {
    const raw = await store.getKv(POLICY_KEY)
    if (raw) {
      const p = JSON.parse(raw)
      // merge over defaults so new categories appear on old installs
      return {
        ...DEFAULT_POLICY, ...p,
        categories: { ...DEFAULT_POLICY.categories, ...(p.categories || {}) },
      }
    }
  } catch { /* defaults */ }
  return DEFAULT_POLICY
}

export async function setSpendPolicy(store: Store, patch: Partial<SpendPolicy>): Promise<SpendPolicy> {
  const cur = await getSpendPolicy(store)
  const next: SpendPolicy = {
    ...cur, ...patch,
    categories: { ...cur.categories, ...(patch.categories || {}) },
  }
  // gifts stay ask-only no matter what the UI sends
  next.categories.gifts.tier = 'ask'
  await store.putKv(POLICY_KEY, JSON.stringify(next), 0)
  return next
}

export interface WeekSpend { totalCents: number; byCategory: Partial<Record<SpendCategory, number>> }

export async function getWeekSpend(store: Store, week = isoWeek()): Promise<WeekSpend> {
  try { return JSON.parse((await store.getKv(WEEK_KEY(week))) || '') } catch { return { totalCents: 0, byCategory: {} } }
}

async function addWeekSpend(store: Store, category: SpendCategory, cents: number): Promise<void> {
  const w = isoWeek()
  const s = await getWeekSpend(store, w)
  s.totalCents += cents
  s.byCategory[category] = (s.byCategory[category] ?? 0) + cents
  await store.putKv(WEEK_KEY(w), JSON.stringify(s), 60 * 60 * 24 * 21)
}

export interface SpendRequest {
  member: string            // email
  category: SpendCategory
  amountCents: number
  service: string
  summary: string
}
export type SpendDecision =
  | { decision: 'auto'; note: string }
  | { decision: 'ask'; note: string }
  | { decision: 'refused'; reason: string }

/** The choke point. Pure decision — the caller runs the approval card for
 *  'ask' and then MUST call recordSpend on success (auto or approved). */
export async function authorizeSpend(store: Store, req: SpendRequest): Promise<SpendDecision> {
  // Member profile: commerce can be switched off entirely (kids).
  try {
    const { findUser } = await import('../auth/otp.js')
    const u = await findUser(store, req.member)
    if (u && u.role !== 'owner' && (u.disabled_apps || []).includes('commerce')) {
      return { decision: 'refused', reason: `Ordering is turned off for this member's profile — the owner can enable it in Settings → Users.` }
    }
  } catch { /* unknown member falls through to policy */ }

  const policy = await getSpendPolicy(store)
  const cat = policy.categories[req.category] ?? policy.categories.other
  const week = await getWeekSpend(store)
  const fmt = (c: number) => `$${(c / 100).toFixed(2)}`

  if (cat.tier === 'never') return { decision: 'refused', reason: `${req.category} purchases are switched off in Budgets.` }
  if (req.amountCents > cat.neverOver) {
    return { decision: 'refused', reason: `${fmt(req.amountCents)} is over the ${req.category} ceiling of ${fmt(cat.neverOver)} — an owner can raise it in Settings → Budgets.` }
  }
  if (week.totalCents + req.amountCents > policy.weeklyCapCents) {
    return { decision: 'refused', reason: `this would take the week to ${fmt(week.totalCents + req.amountCents)}, past the ${fmt(policy.weeklyCapCents)} weekly cap (${fmt(week.totalCents)} spent so far).` }
  }

  const note = `${fmt(req.amountCents)} · ${req.category} · counts against ${fmt(week.byCategory[req.category] ?? 0)} + this week`
  if (req.category === 'gifts') return { decision: 'ask', note }   // permanently ask

  if (cat.tier === 'earned' && req.amountCents <= cat.askUnder) {
    const earned = await getEarned(store, req.category)
    if (earned.auto) return { decision: 'auto', note }
  }
  return { decision: 'ask', note }
}

interface Earned { count: number; auto: boolean }
export async function getEarned(store: Store, category: string): Promise<Earned> {
  try { return JSON.parse((await store.getKv(EARNED_KEY(category))) || '') } catch { return { count: 0, auto: false } }
}

/** Record the outcome AFTER an auto-run or an approved card. Returns whether
 *  this approval crossed the earn threshold (caller may offer auto-tier). */
export async function recordSpend(store: Store, req: SpendRequest, how: 'auto' | 'approved'): Promise<{ offerAuto: boolean }> {
  await addWeekSpend(store, req.category, req.amountCents)
  let offerAuto = false
  if (how === 'approved' && req.category !== 'gifts') {
    const e = await getEarned(store, req.category)
    e.count += 1
    if (!e.auto && e.count >= EARN_AT) offerAuto = true
    await store.putKv(EARNED_KEY(req.category), JSON.stringify(e), 0)
  }
  log.info('spend_recorded', { category: req.category, cents: req.amountCents, how })
  return { offerAuto }
}

export async function setAutoTier(store: Store, category: SpendCategory, auto: boolean): Promise<void> {
  if (category === 'gifts') return
  const e = await getEarned(store, category)
  e.auto = auto
  if (!auto) e.count = 0
  await store.putKv(EARNED_KEY(category), JSON.stringify(e), 0)
  if (auto) {
    const p = await getSpendPolicy(store)
    p.categories[category].tier = 'earned'
    await store.putKv(POLICY_KEY, JSON.stringify(p), 0)
  }
}

/** Denial resets the streak — autonomy is earned by consistency. */
export async function recordSpendDenied(store: Store, category: SpendCategory): Promise<void> {
  const e = await getEarned(store, category)
  e.count = 0
  await store.putKv(EARNED_KEY(category), JSON.stringify(e), 0)
}
