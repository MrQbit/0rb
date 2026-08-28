/**
 * Service-connector framework (SPEC §2). Ten services must feel like one
 * drawer; adding the eleventh must be a file, not a project. A connector
 * declares its mechanism honestly:
 *   api     — the orb can place/track directly
 *   handoff — the orb builds the cart and a human taps Pay at the merchant
 *   watch   — the orb can only track (mail/tracking numbers)
 */
import type { Store } from '../store/store.js'
import type { SpendCategory } from './policy.js'

export interface CartItem { id: string; name: string; qty: number; cents: number }
export interface Cart {
  service: string
  category: SpendCategory
  items: CartItem[]
  subtotalCents: number
  feesCents: number
  totalCents: number
  etaMinutes?: number
  note?: string
}
export type OrderState =
  | 'draft' | 'awaiting-payment' | 'placed' | 'in-progress'
  | 'delivered' | 'canceled' | 'refund-pending' | 'refunded'

export interface OrderStatus { state: OrderState; eta?: string; tracking?: string; note?: string }

export interface ServiceConnector {
  id: string
  label: string
  category: SpendCategory
  mechanism: 'api' | 'handoff' | 'watch'
  link: 'relay-oauth' | 'credentials' | 'none'
  /** Search/menu for an intent ("thai", "petg filament"). */
  options(store: Store, member: string, intent: string): Promise<CartItem[]>
  buildCart(store: Store, member: string, items: Array<{ id: string; qty?: number }>): Promise<Cart>
  /** handoff: the URL a human opens to pay. */
  checkoutUrl?(cart: Cart): string
  /** api: place directly. Returns the service-side reference. */
  placeOrder?(store: Store, member: string, cart: Cart): Promise<{ ref: string; eta?: string }>
  track?(store: Store, member: string, ref: string): Promise<OrderStatus>
  cancel?(store: Store, member: string, ref: string): Promise<boolean>
}

const registry = new Map<string, ServiceConnector>()

export function registerConnector(c: ServiceConnector): void {
  registry.set(c.id, c)
}
export function getConnector(id: string): ServiceConnector | undefined {
  return registry.get(id)
}
export function listConnectors(): ServiceConnector[] {
  return [...registry.values()]
}

/** Boot-time registration: sim connectors (when enabled) + real ones. */
export async function initConnectors(): Promise<void> {
  const { simCommerceEnabled } = await import('./sim.js')
  if (simCommerceEnabled()) {
    const { simConnectors } = await import('./simConnectors.js')
    for (const c of simConnectors()) registerConnector(c)
  }
  try {
    const { realConnectors } = await import('./realConnectors.js')
    for (const c of realConnectors()) registerConnector(c)
  } catch { /* arrives in Stage 4 */ }
}
