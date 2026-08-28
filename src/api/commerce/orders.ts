/**
 * Order lifecycle (SPEC §3): the difference between "I ordered" and the
 * truth is a state machine. Orders move draft → awaiting-payment (handoff)
 * → placed → in-progress → delivered / canceled / refund-*; the orb NEVER
 * claims a placement it didn't observe (api response, or mail-watch /
 * human confirmation for handoff). Every terminal spend writes a receipt
 * with refund-path reversibility, and every transition journals.
 */
import type { Store } from '../store/store.js'
import type { Cart, OrderState } from './connector.js'
import { log } from '../log.js'

export interface OrderRecord {
  id: string
  member: string
  service: string
  category: string
  state: OrderState
  cart: Cart
  createdAt: number
  placedAt?: number
  eta?: string
  tracking?: string
  serviceRef?: string
  checkoutUrl?: string
  receiptId?: string
  giftFor?: string
  source: 'api' | 'handoff' | 'mail'
}

const KEY = (id: string) => `order:${id}`
const OPEN_KEY = 'orders:open'
const TERMINAL: OrderState[] = ['delivered', 'canceled', 'refunded']

async function openIds(store: Store): Promise<string[]> {
  try { return JSON.parse((await store.getKv(OPEN_KEY)) || '[]') } catch { return [] }
}
async function setOpenIds(store: Store, ids: string[]): Promise<void> {
  await store.putKv(OPEN_KEY, JSON.stringify(ids), 0)
}

export async function getOrder(store: Store, id: string): Promise<OrderRecord | null> {
  try { return JSON.parse((await store.getKv(KEY(id))) || 'null') } catch { return null }
}

export async function listOpenOrders(store: Store, member?: string): Promise<OrderRecord[]> {
  const out: OrderRecord[] = []
  for (const id of await openIds(store)) {
    const o = await getOrder(store, id)
    if (o && !TERMINAL.includes(o.state)) {
      if (!member || o.member === member || !o.giftFor) out.push(o)
    }
  }
  return out
}

export async function createOrder(store: Store, o: Omit<OrderRecord, 'id' | 'createdAt' | 'state'> & { state?: OrderState }): Promise<OrderRecord> {
  const rec: OrderRecord = {
    id: `ord-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    createdAt: Date.now(), state: o.state ?? 'draft', ...o,
  }
  await store.putKv(KEY(rec.id), JSON.stringify(rec), 60 * 60 * 24 * 90)
  await setOpenIds(store, [...(await openIds(store)), rec.id])
  return rec
}

export async function transition(store: Store, id: string, state: OrderState, patch: Partial<OrderRecord> = {}): Promise<OrderRecord | null> {
  const o = await getOrder(store, id)
  if (!o) return null
  const prev = o.state
  Object.assign(o, patch, { state })
  if (state === 'placed' && !o.placedAt) o.placedAt = Date.now()
  await store.putKv(KEY(id), JSON.stringify(o), 60 * 60 * 24 * 90)
  if (TERMINAL.includes(state)) await setOpenIds(store, (await openIds(store)).filter(x => x !== id))
  log.info('order_transition', { id, from: prev, to: state })

  // Journal + receipt on the transitions that matter.
  const { logEvent } = await import('../events/journal.js')
  const fmt = `$${(o.cart.totalCents / 100).toFixed(2)}`
  const label = `${o.service}: ${o.cart.items.map(i => i.name).join(', ').slice(0, 60)}`
  if (state === 'placed' && prev !== 'placed') {
    const { recordReceipt } = await import('../policy/policy.js')
    const r = await recordReceipt(store, {
      user: `user:${o.member}`, tool: 'Order', key: `order:${o.service}`,
      summary: `Ordered ${fmt} — ${label}`,
    } as any)
    o.receiptId = r.id
    await store.putKv(KEY(id), JSON.stringify(o), 60 * 60 * 24 * 90)
    await logEvent(store, { kind: 'spend', member: o.member, summary: `Ordered ${fmt} — ${label}`, ref: id, attention: 'glance', giftFor: o.giftFor })
  } else if (state === 'in-progress') {
    await logEvent(store, { kind: 'order', member: o.member, summary: `${o.service} on the way${o.eta ? ` · ETA ${o.eta}` : ''}`, ref: id, attention: 'ambient', giftFor: o.giftFor })
  } else if (state === 'delivered') {
    await logEvent(store, { kind: 'delivery', member: o.member, summary: `Delivered: ${label}`, ref: id, attention: 'notify', giftFor: o.giftFor })
  } else if (state === 'canceled') {
    await logEvent(store, { kind: 'order', member: o.member, summary: `Canceled: ${label}`, ref: id, attention: 'glance', giftFor: o.giftFor })
  } else if (state === 'refunded') {
    await logEvent(store, { kind: 'spend', member: o.member, summary: `Refunded ${fmt} — ${o.service}`, ref: id, attention: 'notify', giftFor: o.giftFor })
  }
  return o
}

/** Proactive lane: poll open orders through their connector's track(). */
export async function tickOrders(store: Store): Promise<void> {
  const { getConnector } = await import('./connector.js')
  for (const o of await listOpenOrders(store)) {
    if (!o.serviceRef || o.state === 'draft' || o.state === 'awaiting-payment') {
      // handoff orders awaiting payment for > 2h expire quietly
      if (o.state === 'awaiting-payment' && Date.now() - o.createdAt > 2 * 3600_000) {
        await transition(store, o.id, 'canceled')
      }
      continue
    }
    const c = getConnector(o.service)
    if (!c?.track) continue
    try {
      const st = await c.track(store, o.member, o.serviceRef)
      if (st.state !== o.state) await transition(store, o.id, st.state, { eta: st.eta, tracking: st.tracking })
      else if (st.eta && st.eta !== o.eta) await transition(store, o.id, o.state, { eta: st.eta })
    } catch { /* transient */ }
  }
}

/** Widget spec for an order (catalog type 'order'). */
export function orderWidget(o: OrderRecord): any {
  return {
    id: `order-${o.id}`, type: 'order', title: o.service,
    state: o.state, service: o.service, total_cents: o.cart.totalCents,
    eta: o.eta, tracking: o.tracking, checkout_url: o.checkoutUrl,
    items: o.cart.items.map(i => ({ name: i.name, qty: i.qty, cents: i.cents })),
    pill: o.state === 'in-progress' ? `on the way${o.eta ? ' · ' + o.eta : ''}` : o.state,
  }
}
