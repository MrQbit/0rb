import { describe, test, expect, beforeAll } from 'bun:test'
import { createOrder, transition, listOpenOrders, tickOrders, getOrder } from './orders.ts'
import { initConnectors, getConnector } from './connector.ts'

beforeAll(async () => {
  process.env.ORB2_SIM_COMMERCE = '1'
  process.env.ORB2_SIM_SPEED_MS = '30'    // 1 sim minute = 30ms
  await initConnectors()
})

function memStore() {
  const kv = new Map<string, string>()
  return {
    async getKv(k: string) { return kv.get(k) ?? null },
    async putKv(k: string, v: string) { kv.set(k, v) },
    async delKv(k: string) { kv.delete(k) },
  } as any
}

describe('order lifecycle (SPEC §3)', () => {
  test('api connector: place → in-progress → delivered via tick; journal + receipt', async () => {
    const s = memStore()
    const c = getConnector('sim-eats')!
    const cart = await c.buildCart(s, 'a@x.com', [{ id: 'thai-1' }, { id: 'soup-1' }])
    expect(cart.totalCents).toBeGreaterThan(4000)
    const placed = await c.placeOrder!(s, 'a@x.com', cart)
    const rec = await createOrder(s, { member: 'a@x.com', service: 'sim-eats', category: 'food', cart, source: 'api', serviceRef: placed.ref })
    await transition(s, rec.id, 'placed')
    expect((await listOpenOrders(s))).toHaveLength(1)
    await new Promise(r => setTimeout(r, 25 * 30 + 60))   // past sim ETA
    await tickOrders(s)
    const done = await getOrder(s, rec.id)
    expect(done!.state).toBe('delivered')
    expect((await listOpenOrders(s))).toHaveLength(0)
    const { listEvents } = await import('../events/journal.ts')
    const kinds = (await listEvents(s)).map(e => e.kind)
    expect(kinds).toContain('spend')
    expect(kinds).toContain('delivery')
    const receipts = JSON.parse((await s.getKv('receipts:ring')) || '[]')
    expect(receipts.some((r: any) => r.summary.includes('Ordered'))).toBe(true)
  })

  test('handoff: awaiting-payment never claims placed; stale carts expire', async () => {
    const s = memStore()
    const c = getConnector('sim-store')!
    const cart = await c.buildCart(s, 'a@x.com', [{ id: 'petg-1' }])
    const rec = await createOrder(s, { member: 'a@x.com', service: 'sim-store', category: 'consumables', cart, source: 'handoff', checkoutUrl: c.checkoutUrl!(cart), state: 'awaiting-payment' })
    expect(rec.state).toBe('awaiting-payment')
    await tickOrders(s)
    expect((await getOrder(s, rec.id))!.state).toBe('awaiting-payment')  // no silent placement
    // simulate 3h staleness
    const raw = JSON.parse((await s.getKv(`order:${rec.id}`))!)
    raw.createdAt = Date.now() - 3 * 3600_000
    await s.putKv(`order:${rec.id}`, JSON.stringify(raw))
    await tickOrders(s)
    expect((await getOrder(s, rec.id))!.state).toBe('canceled')
  })

  test('gift orders carry spoiler guard into journal', async () => {
    const s = memStore()
    const c = getConnector('sim-store')!
    const cart = await c.buildCart(s, 'owner@x.com', [{ id: 'coffee-1' }])
    const rec = await createOrder(s, { member: 'owner@x.com', service: 'sim-store', category: 'gifts', cart, source: 'api', serviceRef: 'x', giftFor: 'ana@x.com' })
    await transition(s, rec.id, 'placed')
    const { listEvents } = await import('../events/journal.ts')
    expect((await listEvents(s, { member: 'ana@x.com' })).filter(e => e.ref === rec.id)).toHaveLength(0)
    expect((await listEvents(s, { member: 'owner@x.com' })).filter(e => e.ref === rec.id).length).toBeGreaterThan(0)
  })
})
