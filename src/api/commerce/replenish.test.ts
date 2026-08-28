import { describe, test, expect, beforeAll } from 'bun:test'
import { upsertConsumable, consume, tickReplenish, listConsumables } from './replenish.ts'

beforeAll(() => { process.env.ORB2_SIM_COMMERCE = '1'; process.env.ORB2_SIM_SPEED_MS = '30' })

function memStore() {
  const kv = new Map<string, string>()
  return {
    async getKv(k: string) { return kv.get(k) ?? null },
    async putKv(k: string, v: string) { kv.set(k, v) },
    async delKv(k: string) { kv.delete(k) },
  } as any
}

describe('replenishment engine (SPEC §7)', () => {
  test('metered: consume to threshold → cart-ready notify (handoff, ask tier)', async () => {
    const s = memStore()
    await upsertConsumable(s, { name: 'PETG Matte Black', service: 'sim-store', itemId: 'petg-1',
      model: { kind: 'metered', remaining: 1000, unit: 'g', threshold: 250 } })
    await consume(s, 'petg', 800)   // 200g left < 250 threshold
    await tickReplenish(s)
    const { listEvents } = await import('../events/journal.ts')
    const evs = await listEvents(s)
    expect(evs.some(e => /Running low: PETG/.test(e.summary) && /Cart ready/.test(e.summary))).toBe(true)
    const { listOpenOrders } = await import('./orders.ts')
    const open = await listOpenOrders(s)
    expect(open).toHaveLength(1)
    expect(open[0]!.state).toBe('awaiting-payment')
    // no double-order on the next tick
    await tickReplenish(s)
    expect((await listOpenOrders(s))).toHaveLength(1)
  })

  test('earned auto + api service → places by itself, journaled', async () => {
    const s = memStore()
    const { setAutoTier } = await import('./policy.ts')
    await setAutoTier(s, 'consumables', true)
    await upsertConsumable(s, { name: 'Thai staples', service: 'sim-eats', itemId: 'thai-1',
      model: { kind: 'metered', remaining: 0, unit: 'count', threshold: 1 } })
    await tickReplenish(s)
    const { listEvents } = await import('../events/journal.ts')
    expect((await listEvents(s)).some(e => /Restocked automatically/.test(e.summary))).toBe(true)
    const { getWeekSpend } = await import('./policy.ts')
    expect((await getWeekSpend(s)).totalCents).toBeGreaterThan(0)
  })

  test('cadence model comes due by interval', async () => {
    const s = memStore()
    await upsertConsumable(s, { name: 'Coffee', service: 'sim-store', itemId: 'coffee-1',
      model: { kind: 'cadence', intervalDays: 14, lastRestock: Date.now() - 13 * 86400_000, leadDays: 2 } })
    await tickReplenish(s)
    expect((await listConsumables(s))[0]!.lastOrderedAt).toBeTruthy()
  })
})
