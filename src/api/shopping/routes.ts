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
  try { return JSON.parse((await store.getKv(KEY)) || '[]') } catch { return [] }
}
export async function saveShoppingList(store: Store, items: ShoppingItem[]): Promise<void> {
  await store.putKv(KEY, JSON.stringify(items), 0)
}
export function newShoppingItem(name: string, qty?: number, note?: string): ShoppingItem {
  return { id: `si-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`, name: name.trim().slice(0, 120), qty, note: note?.slice(0, 200), done: false, added: Date.now() }
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
    const item = newShoppingItem(name, Number(b.qty) || undefined, b.note ? String(b.note) : undefined)
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
