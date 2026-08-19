/**
 * Wallet — payment method METADATA only. Orb stores a label, brand, last4
 * and kind per method so the user can see and choose how to pay; it never
 * stores card numbers, tokens, or credentials. Actual payment happens in
 * the browser's own Apple Pay / Google Pay sheet (Payment Request API) or
 * the merchant's checkout — Orb only helps pick the instrument.
 *
 *   GET    /v1/wallet             → { methods, selected }
 *   POST   /v1/wallet/add        { label, kind, brand?, last4? }
 *   POST   /v1/wallet/select     { id }
 *   DELETE /v1/wallet/<id>
 */
import type { Store } from '../store/store.js'
import { authEnabled, verifySession, parseCookies, SESSION_COOKIE } from '../auth/session.js'

const KEY = 'wallet:methods'
const SEL = 'wallet:selected'

export interface WalletMethod {
  id: string
  label: string
  kind: 'card' | 'applepay' | 'googlepay'
  brand?: string
  last4?: string
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

export async function walletMethods(store: Store): Promise<{ methods: WalletMethod[]; selected: string | null }> {
  let methods: WalletMethod[] = []
  try { methods = JSON.parse((await store.getKv(KEY)) || '[]') } catch { /* fresh */ }
  const selected = (await store.getKv(SEL)) || null
  return { methods, selected }
}

export async function tryWalletRoute(req: Request, method: string, pathname: string, store: Store): Promise<Response | null> {
  if (!pathname.startsWith('/v1/wallet')) return null
  if (!authed(req)) return json(401, { error: 'authentication required' })

  if (method === 'GET' && pathname === '/v1/wallet') {
    return json(200, await walletMethods(store))
  }
  if (method === 'POST' && pathname === '/v1/wallet/add') {
    const b = (await req.json().catch(() => ({}))) as any
    const label = String(b.label || '').trim().slice(0, 60)
    const kind = ['card', 'applepay', 'googlepay'].includes(b.kind) ? b.kind : 'card'
    const brand = String(b.brand || '').trim().slice(0, 20)
    const last4 = String(b.last4 || '').trim()
    if (!label) return json(400, { error: 'label required' })
    // Hard guard: last4 means LAST FOUR. Anything longer is refused so a
    // full card number can never land in the store, even by accident.
    if (last4 && !/^\d{4}$/.test(last4)) return json(400, { error: 'last4 must be exactly 4 digits — never send a full card number' })
    const { methods } = await walletMethods(store)
    const m: WalletMethod = { id: `pm-${Date.now().toString(36)}`, label, kind, brand: brand || undefined, last4: last4 || undefined }
    methods.push(m)
    await store.putKv(KEY, JSON.stringify(methods), 0)
    return json(200, { added: m })
  }
  if (method === 'POST' && pathname === '/v1/wallet/select') {
    const b = (await req.json().catch(() => ({}))) as any
    const { methods } = await walletMethods(store)
    if (!methods.some(m => m.id === b.id)) return json(404, { error: 'no such method' })
    await store.putKv(SEL, String(b.id), 0)
    return json(200, { selected: b.id })
  }
  const del = pathname.match(/^\/v1\/wallet\/(pm-[a-z0-9]+)$/)
  if (method === 'DELETE' && del) {
    const { methods, selected } = await walletMethods(store)
    const next = methods.filter(m => m.id !== del[1])
    if (next.length === methods.length) return json(404, { error: 'no such method' })
    await store.putKv(KEY, JSON.stringify(next), 0)
    if (selected === del[1]) await store.putKv(SEL, '', 0)
    return json(200, { removed: del[1] })
  }
  return null
}
