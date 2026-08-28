/**
 * Sim connectors (SPEC Part V): full ServiceConnector implementations over
 * the deterministic catalogs — api-mechanism sim-eats/sim-rides (place +
 * clock-driven courier/trip states) and handoff-mechanism sim-store (cart
 * → checkout URL → 'paid' confirm). Time is scaled: 1 sim minute =
 * ORB2_SIM_SPEED_MS (default 2000 ms) so Playwright can watch a delivery.
 */
import type { Store } from '../store/store.js'
import type { ServiceConnector, Cart, CartItem, OrderStatus } from './connector.js'
import { SIM_CATALOG } from './sim.js'

const SPEED = () => Number(process.env.ORB2_SIM_SPEED_MS || 2000)
const PLACED_KEY = (ref: string) => `simorder:${ref}`

function catalogItems(service: keyof typeof SIM_CATALOG, intent: string): CartItem[] {
  const menu = SIM_CATALOG[service].menu
  const q = intent.toLowerCase()
  const hits = menu.filter(m => !q || m.name.toLowerCase().includes(q) || m.id.includes(q))
  return (hits.length ? hits : [...menu]).map(m => ({ id: m.id, name: m.name, qty: 1, cents: m.cents }))
}

function makeCart(service: keyof typeof SIM_CATALOG, items: Array<{ id: string; qty?: number }>): Cart {
  const menu = SIM_CATALOG[service].menu
  const line = items
    .map(i => { const m = menu.find(x => x.id === i.id); return m ? { id: m.id, name: m.name, qty: i.qty ?? 1, cents: m.cents } : null })
    .filter(Boolean) as CartItem[]
  const subtotal = line.reduce((s, i) => s + i.cents * i.qty, 0)
  const fees = Math.round(subtotal * 0.1)
  return {
    service, category: SIM_CATALOG[service].category, items: line,
    subtotalCents: subtotal, feesCents: fees, totalCents: subtotal + fees,
    etaMinutes: SIM_CATALOG[service].etaMinutes,
  }
}

async function simPlace(store: Store, service: keyof typeof SIM_CATALOG, cart: Cart): Promise<{ ref: string; eta?: string }> {
  const ref = `sim-${Date.now().toString(36)}`
  await store.putKv(PLACED_KEY(ref), JSON.stringify({ placedAt: Date.now(), etaMin: cart.etaMinutes ?? 20 }), 3600)
  return { ref, eta: `${cart.etaMinutes} min` }
}

async function simTrack(store: Store, ref: string): Promise<OrderStatus> {
  let rec: { placedAt: number; etaMin: number }
  try { rec = JSON.parse((await store.getKv(PLACED_KEY(ref))) || '') } catch { return { state: 'delivered' } }
  const elapsed = Date.now() - rec.placedAt
  const total = rec.etaMin * SPEED()
  if (elapsed >= total) return { state: 'delivered' }
  const leftMin = Math.ceil((total - elapsed) / SPEED())
  return { state: elapsed > total * 0.2 ? 'in-progress' : 'placed', eta: `${leftMin} min` }
}

export function simConnectors(): ServiceConnector[] {
  const base = (id: keyof typeof SIM_CATALOG, mechanism: 'api' | 'handoff'): ServiceConnector => ({
    id, label: SIM_CATALOG[id].label, category: SIM_CATALOG[id].category,
    mechanism, link: 'none',
    async options(_s, _m, intent) { return catalogItems(id, intent) },
    async buildCart(_s, _m, items) { return makeCart(id, items) },
    ...(mechanism === 'api'
      ? {
          async placeOrder(s: Store, _m: string, cart: Cart) { return simPlace(s, id, cart) },
        }
      : {
          checkoutUrl(cart: Cart) { return `https://sim.invalid/checkout?service=${id}&total=${cart.totalCents}` },
        }),
    async track(s, _m, ref) { return simTrack(s, ref) },
    async cancel(s, _m, ref) { await s.delKv(`simorder:${ref}`).catch(() => {}); return true },
  })
  return [base('sim-eats', 'api'), base('sim-rides', 'api'), base('sim-store', 'handoff')]
}
