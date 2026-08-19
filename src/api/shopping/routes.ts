/**
 * Shopping list — persistent, widget-editable.
 *
 *   GET    /v1/shopping                  → { items }
 *   POST   /v1/shopping/add             { name, qty?, note? }
 *   POST   /v1/shopping/toggle          { id }   (done ↔ pending)
 *   DELETE /v1/shopping/<id>
 *
 * Ordering/payment is a HANDOFF, never automatic: Amazon items check out in
 * the user's Amazon account (deep link, their saved payment), everything else
 * goes through the merchant page with the Wallet widget for choosing how to
 * pay. Orb holds no credentials for either.
 */
import type { Store } from '../store/store.js'
import { authEnabled, verifySession, parseCookies, SESSION_COOKIE } from '../auth/session.js'

const KEY = 'shopping:list'

export interface ShoppingItem {
  id: string
  name: string
  qty?: number
  note?: string
  done: boolean
  added: number
  /** staple: re-adds itself this many days after being checked off */
  recur_days?: number
  done_at?: number
}

/**
 * Recurrence sweep (pure): staples checked off longer than their cycle ago
 * come back as open items. Returns the items that revived.
 */
export function sweepRecurring(items: ShoppingItem[], now = Date.now()): ShoppingItem[] {
  const revived: ShoppingItem[] = []
  for (const it of items) {
    if (it.done && it.recur_days && it.done_at && now - it.done_at >= it.recur_days * 86_400_000) {
      it.done = false
      it.done_at = undefined
      revived.push(it)
    }
  }
  return revived
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
function authed(req: Request): boolean {
  if (!authEnabled()) return true
  const a = req.headers.get('authorization') ?? ''
  let token = /^Bearer\s+/i.test(a) ? a.replace(/^Bearer\s+/i, '').trim() : ''
  if (!token) token = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE] ?? ''
  return !!(token && verifySession(token))
}

export async function shoppingList(store: Store): Promise<ShoppingItem[]> {
  try {
    const items = JSON.parse((await store.getKv(KEY)) || '[]') as ShoppingItem[]
    const revived = sweepRecurring(items)
    if (revived.length) {
      await store.putKv(KEY, JSON.stringify(items), 0)
      try {
        const { notifyOwner } = await import('../home/proactive.js')
        await notifyOwner(`🛒 Back on the shopping list (staples): ${revived.map(r => r.name).join(', ')}`)
      } catch { /* notify is best-effort */ }
    }
    return items
  } catch { return [] }
}
export async function saveShoppingList(store: Store, items: ShoppingItem[]): Promise<void> {
  await store.putKv(KEY, JSON.stringify(items), 0)
}
export function newShoppingItem(name: string, qty?: number, note?: string, recurDays?: number): ShoppingItem {
  return { id: `si-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`, name: name.trim().slice(0, 120), qty, note: note?.slice(0, 200), done: false, added: Date.now(), recur_days: recurDays && recurDays > 0 ? Math.round(recurDays) : undefined }
}

export async function tryShoppingRoute(req: Request, method: string, pathname: string, store: Store): Promise<Response | null> {
  if (!pathname.startsWith('/v1/shopping')) return null
  if (!authed(req)) return json(401, { error: 'authentication required' })

  if (method === 'GET' && pathname === '/v1/shopping') {
    return json(200, { items: await shoppingList(store) })
  }
  if (method === 'POST' && pathname === '/v1/shopping/add') {
    const b = (await req.json().catch(() => ({}))) as any
    const name = String(b.name || '').trim()
    if (!name) return json(400, { error: 'name required' })
    const items = await shoppingList(store)
    const item = newShoppingItem(name, Number(b.qty) || undefined, b.note ? String(b.note) : undefined, Number(b.every_days) || undefined)
    items.push(item)
    await saveShoppingList(store, items)
    return json(200, { added: item })
  }
  if (method === 'POST' && pathname === '/v1/shopping/toggle') {
    const b = (await req.json().catch(() => ({}))) as any
    const items = await shoppingList(store)
    const it = items.find(i => i.id === b.id)
    if (!it) return json(404, { error: 'no such item' })
    it.done = !it.done
    it.done_at = it.done ? Date.now() : undefined
    await saveShoppingList(store, items)
    return json(200, { item: it })
  }
  const del = pathname.match(/^\/v1\/shopping\/(si-[a-z0-9-]+)$/)
  if (method === 'DELETE' && del) {
    const items = await shoppingList(store)
    const next = items.filter(i => i.id !== del[1])
    if (next.length === items.length) return json(404, { error: 'no such item' })
    await saveShoppingList(store, next)
    return json(200, { removed: del[1] })
  }
  return null
}
