/**
 * The accounts hub (integrations rework): ONE place that answers "what's in
 * this member's mail / on their calendar" across every provider they've
 * connected — Google, Microsoft, Apple. Consumers (the morning deck, the
 * agent) never talk to a provider directly; connecting a new account makes
 * everything that reads through the hub light up at once.
 */
import type { Store } from '../store/store.js'
import type { MailPreview } from '../connectors/google.js'

export interface MergedMail extends MailPreview {
  providers: string[]
}

/** Unread mail across every connected mail source. Null when none connected. */
export async function unreadMailAll(store: Store, member?: string, maxPer = 5): Promise<MergedMail | null> {
  const providers: string[] = []
  let total = 0
  const messages: MailPreview['messages'] = []
  try {
    const { unreadMail } = await import('../connectors/google.js')
    const g = await unreadMail(store, maxPer, member)
    if (g) { providers.push('Gmail'); total += g.total; messages.push(...g.messages) }
  } catch { /* provider optional */ }
  try {
    const { unreadOutlook } = await import('../connectors/microsoft.js')
    const o = await unreadOutlook(store, member, maxPer)
    if (o) { providers.push('Outlook'); total += o.total; messages.push(...o.messages) }
  } catch { /* provider optional */ }
  if (!providers.length) return null
  messages.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
  return { total, messages: messages.slice(0, maxPer + 2), providers }
}

export interface MergedEvent { time?: string; title: string; source: string }

/** Today's events across every connected calendar. Empty array = connected but
 *  free day; null = nothing connected at all. */
export async function todaysEventsAll(store: Store, member?: string, now = new Date()): Promise<MergedEvent[] | null> {
  const out: MergedEvent[] = []
  let any = false
  try {
    const { todaysGoogleEvents } = await import('../connectors/google.js')
    const g = await todaysGoogleEvents(store, now, member)
    if (g) { any = true; out.push(...g.map(e => ({ ...e, source: 'Google' }))) }
  } catch { /* optional */ }
  try {
    const { todaysOutlookEvents } = await import('../connectors/microsoft.js')
    const o = await todaysOutlookEvents(store, member, now)
    if (o) { any = true; out.push(...o.map(e => ({ ...e, source: 'Outlook' }))) }
  } catch { /* optional */ }
  if (member) {
    try {
      const { todaysAppleEvents } = await import('../connectors/apple.js')
      const a = await todaysAppleEvents(store, member, now)
      if (a) { any = true; out.push(...a.map(e => ({ ...e, source: 'iCloud' }))) }
    } catch { /* optional */ }
  }
  if (!any) return null
  const t = (e: MergedEvent) => e.time ? new Date(`2000-01-01 ${e.time}`).getTime() : 0
  return out.sort((a, b) => t(a) - t(b))
}

/** Which providers this member can read through, for honest availability UI. */
export async function connectedProviders(store: Store, member?: string): Promise<{ google: boolean; microsoft: boolean; apple: boolean; spotify: boolean }> {
  let google = false, microsoft = false, apple = false, spotify = false
  try {
    const { isConnected } = await import('../connectors/cloudStorageOAuth.js')
    google = await isConnected(store, 'google', member)
    microsoft = await isConnected(store, 'microsoft', member)
  } catch { /* off */ }
  try {
    const { appleConnected } = await import('../connectors/apple.js')
    if (member) apple = await appleConnected(store, member)
  } catch { /* off */ }
  try {
    const { isConnected } = await import('../connectors/spotifyOAuth.js')
    spotify = await isConnected(store, member)
  } catch { /* off */ }
  return { google, microsoft, apple, spotify }
}
