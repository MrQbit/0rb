/**
 * The watch layer (SPEC §10): parse commerce mail — order confirmations,
 * tracking numbers, refunds, subscription renewals — into order records,
 * journal events, and the subscriptions registry. Local-only, sender-
 * allowlisted, extracted fields only; raw mail is never stored.
 */
import type { Store } from '../store/store.js'

export interface MailIn { from: string; subject: string; body: string; date?: string }
export type Parsed =
  | { kind: 'order'; service: string; totalCents?: number }
  | { kind: 'tracking'; carrier: 'ups' | 'usps' | 'fedex'; tracking: string }
  | { kind: 'refund'; service: string; totalCents?: number }
  | { kind: 'subscription'; name: string; amountCents?: number }
  | null

const SENDERS: Array<{ re: RegExp; service: string }> = [
  { re: /@(uber|ubereats)\.com$/i, service: 'ubereats' },
  { re: /@doordash\.com$/i, service: 'doordash' },
  { re: /@(amazon|marketplace\.amazon)\.com$/i, service: 'amazon' },
  { re: /@instacart\.com$/i, service: 'instacart' },
  { re: /@digikey\.com$/i, service: 'digikey' },
  { re: /@lyftmail\.com$/i, service: 'lyft' },
  { re: /@(ups|usps|fedex)\.com$/i, service: 'carrier' },
  { re: /@sim\.invalid$/i, service: 'sim-store' },   // fixtures
]

const money = (t: string): number | undefined => {
  const m = t.match(/(?:total|charged|amount|payment of)[^$]*\$\s?(\d{1,4}(?:[.,]\d{2}))/i) || t.match(/\$\s?(\d{1,4}[.,]\d{2})/)
  return m ? Math.round(parseFloat(m[1]!.replace(',', '.')) * 100) : undefined
}

export function parseMail(mail: MailIn): Parsed {
  const senderDomain = (mail.from.match(/@[\w.-]+/) || [''])[0]
  const hit = SENDERS.find(s => s.re.test(senderDomain))
  if (!hit) return null   // allowlist: unknown senders untouched
  const text = `${mail.subject}\n${mail.body}`

  // tracking numbers first — they're the most distinctive
  const ups = text.match(/\b(1Z[0-9A-Z]{16})\b/)
  if (ups) return { kind: 'tracking', carrier: 'ups', tracking: ups[1]! }
  const usps = text.match(/\b(9[234]\d{20,24})\b/)
  if (usps) return { kind: 'tracking', carrier: 'usps', tracking: usps[1]! }
  const fedex = text.match(/\b(\d{12}|\d{15})\b(?=[^\d]|$)/)
  if (fedex && /fedex/i.test(text + mail.from)) return { kind: 'tracking', carrier: 'fedex', tracking: fedex[1]! }

  if (/refund(ed)?|money back|we've issued/i.test(text)) return { kind: 'refund', service: hit.service, totalCents: money(text) }
  if (/renew(al|ed)?|subscription|your membership/i.test(text)) {
    const name = mail.subject.replace(/receipt|renewal|subscription|your/gi, '').trim().slice(0, 40) || hit.service
    return { kind: 'subscription', name, amountCents: money(text) }
  }
  if (/order (confirm|receipt|placed)|thanks for your (order|riding)|\breceipt\b/i.test(text)) {
    return { kind: 'order', service: hit.service, totalCents: money(text) }
  }
  return null
}

// ── subscriptions registry ──────────────────────────────────────────────
const SUBS_KEY = 'subs:registry'
export interface Sub { name: string; amountCents?: number; lastSeen: number; timesSeen: number }

export async function noteSubscription(store: Store, name: string, amountCents?: number): Promise<void> {
  let subs: Record<string, Sub> = {}
  try { subs = JSON.parse((await store.getKv(SUBS_KEY)) || '{}') } catch { /* fresh */ }
  const key = name.toLowerCase()
  const cur = subs[key]
  subs[key] = { name, amountCents: amountCents ?? cur?.amountCents, lastSeen: Date.now(), timesSeen: (cur?.timesSeen ?? 0) + 1 }
  await store.putKv(SUBS_KEY, JSON.stringify(subs), 0)
}
export async function listSubscriptions(store: Store): Promise<Sub[]> {
  try { return Object.values(JSON.parse((await store.getKv(SUBS_KEY)) || '{}')) } catch { return [] }
}

/**
 * Ingest a batch of mail (from the hub, when a mail account is connected):
 * confirmations attach to awaiting-payment orders (closing the handoff loop
 * without a manual 'I paid'), tracking journals, refunds move orders,
 * renewals feed the registry.
 */
export async function ingestMail(store: Store, mails: MailIn[]): Promise<{ parsed: number }> {
  let parsed = 0
  for (const m of mails) {
    const p = parseMail(m)
    if (!p) continue
    parsed++
    const { logEvent } = await import('../events/journal.js')
    if (p.kind === 'order') {
      const { listOpenOrders, transition } = await import('./orders.js')
      const open = await listOpenOrders(store)
      const match = open.find(o => o.state === 'awaiting-payment' && o.service === p.service
        && (!p.totalCents || Math.abs(o.cart.totalCents - p.totalCents) < 500))
      if (match) {
        const { recordSpend } = await import('./policy.js')
        await recordSpend(store, { member: match.member, category: match.category as any, amountCents: p.totalCents ?? match.cart.totalCents, service: match.service, summary: 'mail-confirmed' }, 'approved')
        await transition(store, match.id, 'placed', { source: 'mail' } as any)
      } else {
        await logEvent(store, { kind: 'spend', summary: `Order confirmed at ${p.service}${p.totalCents ? ` — $${(p.totalCents / 100).toFixed(2)}` : ''}`, attention: 'glance' })
      }
    } else if (p.kind === 'tracking') {
      const { listOpenOrders, transition } = await import('./orders.js')
      const open = (await listOpenOrders(store)).find(o => ['placed', 'in-progress'].includes(o.state) && !o.tracking)
      if (open) await transition(store, open.id, 'in-progress', { tracking: p.tracking })
      else await logEvent(store, { kind: 'delivery', summary: `Package on the way (${p.carrier.toUpperCase()} ${p.tracking.slice(0, 12)}…)`, attention: 'ambient' })
    } else if (p.kind === 'refund') {
      const { listOpenOrders, transition } = await import('./orders.js')
      const open = (await listOpenOrders(store)).find(o => o.service === p.service && o.state === 'refund-pending')
      if (open) await transition(store, open.id, 'refunded')
      else await logEvent(store, { kind: 'spend', summary: `Refund from ${p.service}${p.totalCents ? ` — $${(p.totalCents / 100).toFixed(2)}` : ''}`, attention: 'notify' })
    } else if (p.kind === 'subscription') {
      await noteSubscription(store, p.name, p.amountCents)
    }
  }
  return { parsed }
}

/** Loop lane: when a mail account is connected, sweep recent unread. */
export async function tickMailwatch(store: Store): Promise<void> {
  try {
    const { unreadMailAll } = await import('../accounts/hub.js')
    const mail = await unreadMailAll(store, undefined, 10)
    if (!mail) return
    await ingestMail(store, mail.messages.map(m => ({ from: m.from, subject: m.subject, body: m.snippet, date: m.date })))
  } catch { /* no mail source — fixtures cover the parser */ }
}
