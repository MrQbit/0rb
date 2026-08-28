/**
 * The replenishment engine (SPEC §7): consumables carry a consumption
 * model — metered (grams/units subtracted per use) or cadence (restock
 * intervals) — and when projected-empty crosses the lead time, the engine
 * builds the cart. Earned-auto tiers place api-mechanism orders on their
 * own; everything else becomes ONE quiet notify ("PETG is low — cart
 * ready"). Batching: same-store carts within the window merge.
 */
import type { Store } from '../store/store.js'

export interface Consumable {
  id: string
  name: string
  service: string           // connector id
  itemId: string            // connector item
  model:
    | { kind: 'metered'; remaining: number; unit: string; threshold: number }
    | { kind: 'cadence'; intervalDays: number; lastRestock: number; leadDays: number }
  priceCents?: number
  lastOrderedAt?: number
}

const KEY = 'replenish:items'

export async function listConsumables(store: Store): Promise<Consumable[]> {
  try { return JSON.parse((await store.getKv(KEY)) || '[]') } catch { return [] }
}
async function save(store: Store, items: Consumable[]): Promise<void> {
  await store.putKv(KEY, JSON.stringify(items), 0)
}

export async function upsertConsumable(store: Store, c: Omit<Consumable, 'id'> & { id?: string }): Promise<Consumable> {
  const items = await listConsumables(store)
  const id = c.id || `cn-${Date.now().toString(36)}`
  const idx = items.findIndex(x => x.id === id || x.name.toLowerCase() === c.name.toLowerCase())
  const rec: Consumable = { ...(idx >= 0 ? items[idx]! : {} as any), ...c, id: idx >= 0 ? items[idx]!.id : id }
  if (idx >= 0) items[idx] = rec; else items.push(rec)
  await save(store, items)
  return rec
}

/** Metered use ("the print used 240 g") / restock ("new spool, 1000 g"). */
export async function consume(store: Store, nameOrId: string, amount: number): Promise<Consumable | null> {
  const items = await listConsumables(store)
  const c = items.find(x => x.id === nameOrId || x.name.toLowerCase().includes(nameOrId.toLowerCase()))
  if (!c || c.model.kind !== 'metered') return null
  c.model.remaining = Math.max(0, c.model.remaining - amount)
  await save(store, items)
  return c
}
export async function restock(store: Store, nameOrId: string, amount?: number): Promise<Consumable | null> {
  const items = await listConsumables(store)
  const c = items.find(x => x.id === nameOrId || x.name.toLowerCase().includes(nameOrId.toLowerCase()))
  if (!c) return null
  if (c.model.kind === 'metered' && amount != null) c.model.remaining = amount
  if (c.model.kind === 'cadence') c.model.lastRestock = Date.now()
  c.lastOrderedAt = undefined
  await save(store, items)
  return c
}

function due(c: Consumable): boolean {
  if (c.lastOrderedAt && Date.now() - c.lastOrderedAt < 3 * 86400_000) return false  // don't double-order
  if (c.model.kind === 'metered') return c.model.remaining <= c.model.threshold
  const projectedEmpty = c.model.lastRestock + c.model.intervalDays * 86400_000
  return Date.now() >= projectedEmpty - c.model.leadDays * 86400_000
}

/** Engine tick: due consumables → cart → tier → auto-place or one quiet ask. */
export async function tickReplenish(store: Store): Promise<void> {
  const items = await listConsumables(store)
  const dueItems = items.filter(due)
  if (!dueItems.length) return
  const { initConnectors, getConnector } = await import('./connector.js')
  await initConnectors()
  // batch by service
  const byService = new Map<string, Consumable[]>()
  for (const c of dueItems) (byService.get(c.service) ?? byService.set(c.service, []).get(c.service)!).push(c)

  const { listConnectors } = await import('./connector.js')
  const normId = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '')
  for (const [service, list] of byService) {
    const conn = getConnector(service)
      || listConnectors().find(c => normId(c.id) === normId(service) || normId(c.label) === normId(service))
    if (!conn) continue
    const cart = await conn.buildCart(store, 'household', list.map(c => ({ id: c.itemId })))
    if (!cart.items.length) continue
    const { authorizeSpend, recordSpend } = await import('./policy.js')
    const names = list.map(c => c.name).join(', ')
    const decision = await authorizeSpend(store, { member: 'household', category: 'consumables', amountCents: cart.totalCents, service, summary: names })
    const { logEvent } = await import('../events/journal.js')
    const { createOrder, transition } = await import('./orders.js')

    if (decision.decision === 'auto' && conn.mechanism === 'api' && conn.placeOrder) {
      const placed = await conn.placeOrder(store, 'household', cart)
      const rec = await createOrder(store, { member: 'household', service, category: 'consumables', cart, source: 'api', serviceRef: placed.ref, eta: placed.eta })
      await transition(store, rec.id, 'placed')
      await recordSpend(store, { member: 'household', category: 'consumables', amountCents: cart.totalCents, service, summary: names }, 'auto')
      for (const c of list) c.lastOrderedAt = Date.now()
      await save(store, items)
      await logEvent(store, { kind: 'spend', summary: `Restocked automatically: ${names} — $${(cart.totalCents / 100).toFixed(2)} (${service})`, attention: 'notify', ref: rec.id })
    } else if (decision.decision !== 'refused') {
      // one quiet ask: cart ready, human decides (handoff or non-earned tier)
      const url = conn.checkoutUrl ? conn.checkoutUrl(cart) : undefined
      const rec = await createOrder(store, { member: 'household', service, category: 'consumables', cart, source: conn.mechanism === 'api' ? 'api' : 'handoff', checkoutUrl: url, state: 'awaiting-payment' })
      for (const c of list) c.lastOrderedAt = Date.now()
      await save(store, items)
      await logEvent(store, { kind: 'note', summary: `Running low: ${names}. Cart ready at ${conn.label} — $${(cart.totalCents / 100).toFixed(2)}. Say "order it" or open the checkout.`, attention: 'notify', ref: rec.id })
    } else {
      await logEvent(store, { kind: 'note', summary: `Running low: ${names} — but ${('reason' in decision && decision.reason) || 'budgets refuse the reorder'}`, attention: 'notify' })
    }
  }
}
