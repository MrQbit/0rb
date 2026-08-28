/**
 * Real-service connectors (SPEC §5/§6). Handoff is the floor and the
 * honest default: the orb deep-links the RIGHT screen at the merchant,
 * a human taps Pay, and the loop closes via confirm-paid / mail-watch.
 * (True APIs — Uber Rides — upgrade individual connectors later without
 * touching callers.)
 */
import type { ServiceConnector, Cart, CartItem } from './connector.js'

function q(s: string): string { return encodeURIComponent(s) }

/** A generic search-handoff food connector: options are search hints, the
 *  cart is a stated estimate the human confirms at the merchant. */
function foodHandoff(id: string, label: string, searchUrl: (query: string) => string): ServiceConnector {
  return {
    id, label, category: 'food', mechanism: 'handoff', link: 'none',
    async options(_s, _m, intent) {
      const name = intent.trim() || 'your usual'
      // Handoff services can't enumerate menus; options are honest intents.
      return [{ id: `search:${name}`, name: `Search “${name}” on ${label}`, qty: 1, cents: 0 }]
    },
    async buildCart(_s, _m, items) {
      const first = items[0]?.id || 'search:food'
      const query = first.replace(/^search:/, '')
      const est = items.reduce((sum, i) => sum + (Number((i as any).cents) || 0), 0)
      const line: CartItem[] = [{ id: first, name: `${label}: ${query}`, qty: 1, cents: est }]
      return { service: id, category: 'food', items: line, subtotalCents: est, feesCents: 0, totalCents: est, note: 'estimate — final total at checkout' }
    },
    checkoutUrl(cart: Cart) {
      const query = cart.items[0]?.id.replace(/^search:/, '') || 'food'
      return searchUrl(query)
    },
  }
}

/** Ride handoff: deep-link the ride app with the destination prefilled. */
function rideHandoff(id: string, label: string, url: (o: { dlat?: number; dlng?: number; dname?: string }) => string): ServiceConnector {
  return {
    id, label, category: 'rides', mechanism: 'handoff', link: 'none',
    async options() { return [{ id: 'ride', name: `${label} ride (fare shown in the app)`, qty: 1, cents: 0 }] },
    async buildCart(_s, _m, items) {
      const meta = (items[0] as any) || {}
      return {
        service: id, category: 'rides',
        items: [{ id: 'ride', name: `${label} → ${meta.dname || 'destination'}`, qty: 1, cents: Number(meta.cents) || 0 }],
        subtotalCents: Number(meta.cents) || 0, feesCents: 0, totalCents: Number(meta.cents) || 0,
        note: 'fare shown in the app',
      }
    },
    checkoutUrl(cart: Cart) {
      const name = cart.items[0]?.name.split('→')[1]?.trim()
      return url({ dname: name })
    },
  }
}

export function realConnectors(): ServiceConnector[] {
  return [
    foodHandoff('ubereats', 'Uber Eats', query => `https://www.ubereats.com/search?q=${q(query)}`),
    foodHandoff('doordash', 'DoorDash', query => `https://www.doordash.com/search/store/${q(query)}`),
    rideHandoff('uber', 'Uber', o => `https://m.uber.com/ul/?action=setPickup&pickup=my_location${o.dname ? `&dropoff%5Bnickname%5D=${q(o.dname)}` : ''}${o.dlat != null ? `&dropoff%5Blatitude%5D=${o.dlat}&dropoff%5Blongitude%5D=${o.dlng}` : ''}`),
    rideHandoff('lyft', 'Lyft', o => `https://lyft.com/ride?id=lyft${o.dlat != null ? `&destination%5Blatitude%5D=${o.dlat}&destination%5Blongitude%5D=${o.dlng}` : ''}`),
  ]
}
