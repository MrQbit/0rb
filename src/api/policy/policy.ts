/**
 * The trust layer (v0.2 §2): every agent action has an impact class, every
 * state change leaves a receipt (with an inverse where one exists), actions
 * that matter wait for approval, and approval earns autonomy — per person,
 * revocable, visible.
 *
 *   impact 'read'       → runs silently
 *   impact 'reversible' → runs, leaves a receipt (undoable when derivable)
 *   impact 'confirm'    → blocks on an approval card, then receipt
 *   impact 'never-auto' → the agent may never do it autonomously
 */
import type { Store } from '../store/store.js'
import { emitWidget } from '../widgets/bus.js'
import { log } from '../log.js'

export type Impact = 'read' | 'reversible' | 'confirm' | 'never-auto'

/** Stable key for one kind of action — the unit consent applies to. */
export function actionKey(tool: string, args: any): string {
  const op = String(args?.op || args?.action || '')
  if (tool === 'Home') {
    const act = String(args?.action || '')
    if (act === 'lock' || act === 'unlock') return 'Home:lock'
    if (String(args?.op) === 'mode' && args?.secure) return 'Home:secure'
    return `Home:${op || 'control'}`
  }
  return op ? `${tool}:${op}` : tool
}

/** Base classification — the policy map from the spec. */
export function baseImpact(tool: string, args: any): Impact {
  const op = String(args?.op || '')
  const action = String(args?.action || '')
  switch (tool) {
    case 'Home': {
      // Widget-display ops only SHOW state — they're reads, not actions.
      if (['list', 'status', 'sensors', 'presence', 'camera', 'automations', 'printer',
        'lights', 'media', 'climate', 'vacuum', 'covers', 'security', 'plugs', 'scenes'].includes(op) && !action) return 'read'
      if (action === 'lock' || action === 'unlock') return 'confirm'
      if (op === 'mode' && args?.secure) return 'confirm'
      return 'reversible'
    }
    case 'HomeAdmin':
      if (['areas', 'integrations', 'diagnose', 'suggest'].includes(op)) return 'read'
      if (op === 'automate') return 'confirm'          // creates autonomous behavior
      return 'reversible'
    case 'AirPlay': return op === 'list' ? 'read' : 'reversible'
    case 'Print': return op === 'print' ? 'confirm' : 'read'   // physical paper
    case 'Timer': case 'Shopping': case 'Family': case 'Widget': case 'CreateWidget':
      return 'reversible'
    case 'Settings': return op === 'set' || op === 'connect' ? 'reversible' : 'read'
    case 'Wallet': return op === 'add' || op === 'remove' || op === 'select' ? 'reversible' : 'read'
    default: return 'read'   // read-only tools (search, weather, recall…) stay silent
  }
}

// ── per-user overrides (earned autonomy) ─────────────────────────────────
const OVR_KEY = 'policy:overrides'
type Overrides = Record<string, 'autopilot'>   // "<user>|<actionKey>"

async function overrides(store: Store): Promise<Overrides> {
  try { return JSON.parse((await store.getKv(OVR_KEY)) || '{}') } catch { return {} }
}

export async function effectiveImpact(store: Store, user: string, tool: string, args: any): Promise<Impact> {
  const base = baseImpact(tool, args)
  if (base !== 'confirm') return base
  const o = await overrides(store)
  return o[`${user}|${actionKey(tool, args)}`] === 'autopilot' ? 'reversible' : 'confirm'
}

export async function grantAutonomy(store: Store, user: string, key: string): Promise<void> {
  const o = await overrides(store)
  o[`${user}|${key}`] = 'autopilot'
  await store.putKv(OVR_KEY, JSON.stringify(o), 0)
  log.info('policy_autonomy_granted', { user, key })
}

export async function revokeAutonomy(store: Store, user: string, key: string): Promise<void> {
  const o = await overrides(store)
  delete o[`${user}|${key}`]
  await store.putKv(OVR_KEY, JSON.stringify(o), 0)
}

export async function listAutonomy(store: Store, user: string): Promise<string[]> {
  const o = await overrides(store)
  const prefix = `${user}|`
  return Object.keys(o).filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length))
}

// ── receipts: the household ledger, undo included ────────────────────────
export interface Inverse {
  kind: 'home-control' | 'mode'
  entity_id?: string
  action?: string
  value?: number
  mode?: string
}
export interface Receipt {
  id: string
  ts: number
  user: string
  tool: string
  key: string
  summary: string
  inverse?: Inverse
  undone?: boolean
}

const RING_KEY = 'receipts:ring'
const RING_MAX = 500

async function ring(store: Store): Promise<Receipt[]> {
  try { return JSON.parse((await store.getKv(RING_KEY)) || '[]') } catch { return [] }
}

export async function recordReceipt(store: Store, r: Omit<Receipt, 'id' | 'ts'>): Promise<Receipt> {
  const list = await ring(store)
  const receipt: Receipt = { id: `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, ts: Date.now(), ...r }
  list.push(receipt)
  while (list.length > RING_MAX) list.shift()
  await store.putKv(RING_KEY, JSON.stringify(list), 0)
  // Event journal (SPEC §4): receipts are journal events too.
  void import('../events/journal.js').then(({ logEvent }) => logEvent(store, {
    kind: 'receipt', member: (r.user || '').replace(/^user:/, ''), summary: r.summary,
    ref: receipt.id, attention: 'glance',
  })).catch(() => { /* journal is best-effort */ })
  return receipt
}

export async function listReceipts(store: Store, limit = 50): Promise<Receipt[]> {
  return (await ring(store)).slice(-limit).reverse()
}

/** Execute a receipt's inverse. Returns a human summary or null. */
export async function undoReceipt(store: Store, id: string): Promise<string | null> {
  const list = await ring(store)
  const r = list.find(x => x.id === id)
  if (!r || !r.inverse || r.undone) return null
  const inv = r.inverse
  if (inv.kind === 'home-control' && inv.entity_id && inv.action) {
    const { haCallService } = await import('../connectors/homeAssistant.js')
    const { serviceFor } = await import('../home/routes.js')
    const domain = inv.entity_id.split('.')[0] || ''
    const plan = serviceFor(domain, inv.action, inv.value)
    if (!plan) return null
    await haCallService(domain, plan.service, inv.entity_id, plan.data)
  } else if (inv.kind === 'mode' && inv.mode) {
    const { setMode } = await import('../home/mode.js')
    await setMode(store, inv.mode as any)
  } else return null
  r.undone = true
  await store.putKv(RING_KEY, JSON.stringify(list), 0)
  await recordReceipt(store, { user: r.user, tool: 'Undo', key: 'undo', summary: `Undid: ${r.summary}` })
  return `Undid: ${r.summary}`
}

/** Best-effort inverse for a Home control BEFORE it runs (captures prior state). */
export async function deriveHomeInverse(args: any): Promise<Inverse | undefined> {
  try {
    if (String(args?.op) === 'mode' && args?.mode) {
      return undefined // filled by caller with the prior mode
    }
    return undefined
  } catch { return undefined }
}

// ── approvals: block, card, resolve ──────────────────────────────────────
interface Pending {
  resolve: (v: { approved: boolean; always?: boolean }) => void
  user: string
  key: string
  summary: string
}
const pending = new Map<string, Pending>()
const APPROVAL_TIMEOUT_MS = 120_000
const AUTONOMY_OFFER_AT = 3

async function approvalCount(store: Store, user: string, key: string): Promise<number> {
  return Number((await store.getKv(`policy:approvals:${user}|${key}`)) || 0)
}

export async function requestApproval(
  store: Store, sessionId: string, user: string,
  tool: string, args: any, summary: string, reason: string,
): Promise<{ approved: boolean }> {
  const key = actionKey(tool, args)
  const id = `ap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const count = await approvalCount(store, user, key)
  emitWidget(sessionId, {
    id, type: 'approval', title: 'Approval needed',
    approval_id: id, summary, reason, tool, action_key: key,
    offer_always: count + 1 >= AUTONOMY_OFFER_AT,
    expires_at: Date.now() + APPROVAL_TIMEOUT_MS,
  } as any)
  const result = await new Promise<{ approved: boolean; always?: boolean }>(resolve => {
    pending.set(id, { resolve, user, key, summary })
    setTimeout(() => {
      if (pending.delete(id)) resolve({ approved: false })
    }, APPROVAL_TIMEOUT_MS)
  })
  if (result.approved) {
    await store.putKv(`policy:approvals:${user}|${key}`, String(count + 1), 0)
    if (result.always) await grantAutonomy(store, user, key)
  }
  // Update the card to its final state.
  emitWidget(sessionId, {
    id, type: 'approval', title: result.approved ? 'Approved' : 'Not approved',
    approval_id: id, summary, resolved: true, approved: result.approved,
  } as any)
  return { approved: result.approved }
}

export function resolveApproval(id: string, approved: boolean, always = false): boolean {
  const p = pending.get(id)
  if (!p) return false
  pending.delete(id)
  p.resolve({ approved, always })
  return true
}
