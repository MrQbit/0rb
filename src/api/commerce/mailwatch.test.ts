import { describe, test, expect } from 'bun:test'
import { parseMail, ingestMail, listSubscriptions } from './mailwatch.ts'

function memStore() {
  const kv = new Map<string, string>()
  return {
    async getKv(k: string) { return kv.get(k) ?? null },
    async putKv(k: string, v: string) { kv.set(k, v) },
    async delKv(k: string) { kv.delete(k) },
  } as any
}

const FIX = [
  { from: 'no-reply@doordash.com', subject: 'Order Confirmation', body: 'Thanks for your order! Total: $41.20', want: { kind: 'order', service: 'doordash', totalCents: 4120 } },
  { from: 'orders@amazon.com', subject: 'Your Amazon.com order', body: 'Order placed. Order Total: $23.99', want: { kind: 'order', service: 'amazon', totalCents: 2399 } },
  { from: 'receipts@uber.com', subject: 'Your Friday trip receipt', body: 'Thanks for riding. Payment of $14.32 charged.', want: { kind: 'order', service: 'ubereats' } },
  { from: 'auto-confirm@amazon.com', subject: 'Shipped: your order', body: 'Track your package 1Z999AA10123456784 with UPS', want: { kind: 'tracking', carrier: 'ups', tracking: '1Z999AA10123456784' } },
  { from: 'tracking@usps.com', subject: 'USPS item update', body: 'Your item 9400111899223100001234 is in transit.', want: { kind: 'tracking', carrier: 'usps' } },
  { from: 'shipment@fedex.com', subject: 'FedEx shipment', body: 'FedEx tracking 123456789012 has shipped.', want: { kind: 'tracking', carrier: 'fedex' } },
  { from: 'orders@amazon.com', subject: 'Refund issued', body: "We've issued a refund of $23.99 to your card.", want: { kind: 'refund', service: 'amazon', totalCents: 2399 } },
  { from: 'billing@doordash.com', subject: 'DashPass renewal receipt', body: 'Your subscription renewed. Amount: $9.99', want: { kind: 'subscription' } },
  { from: 'stranger@evil.example', subject: 'Order Confirmation Total $999', body: 'gotcha', want: null },  // allowlist
  { from: 'newsletter@instacart.com', subject: 'Fresh deals this week', body: 'Save on produce!', want: null },  // no signal
]

describe('mail watch (SPEC §10)', () => {
  test('parser fixture suite', () => {
    for (const f of FIX) {
      const p = parseMail({ from: f.from, subject: f.subject, body: f.body })
      if (f.want === null) { expect(p).toBeNull(); continue }
      expect(p).not.toBeNull()
      expect(p!.kind).toBe(f.want.kind as any)
      for (const [k, v] of Object.entries(f.want)) if (k !== 'kind') expect((p as any)[k]).toBe(v)
    }
  })

  test('ingest: confirmation closes an awaiting-payment order; renewal registers', async () => {
    process.env.ORB2_SIM_COMMERCE = '1'
    const s = memStore()
    const { initConnectors, getConnector } = await import('./connector.ts')
    await initConnectors()
    const c = getConnector('sim-store')!
    const cart = await c.buildCart(s, 'a@x.com', [{ id: 'petg-1' }])
    const { createOrder, getOrder } = await import('./orders.ts')
    const rec = await createOrder(s, { member: 'a@x.com', service: 'sim-store', category: 'consumables', cart, source: 'handoff', state: 'awaiting-payment' })
    const r = await ingestMail(s, [
      { from: 'orders@sim.invalid', subject: 'Order Confirmation', body: `Thanks for your order! Total: $${(cart.totalCents / 100).toFixed(2)}` },
      { from: 'billing@doordash.com', subject: 'DashPass renewal', body: 'Your subscription renewed. Amount: $9.99' },
    ])
    expect(r.parsed).toBe(2)
    expect((await getOrder(s, rec.id))!.state).toBe('placed')          // handoff loop closed by MAIL, no human tap
    const subs = await listSubscriptions(s)
    expect(subs.some(x => /dashpass/i.test(x.name))).toBe(true)
  })
})
