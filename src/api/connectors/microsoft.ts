/**
 * Microsoft Graph reads: unread Outlook mail + today's Calendar. The single
 * Microsoft connection (Settings → Apps) already carries Mail.Read +
 * Calendars.Read + Files.Read — one consent lights everything up. Every
 * function returns null when Microsoft isn't connected.
 */
import type { Store } from '../store/store.js'
import { getToken } from './cloudStorageOAuth.js'
import type { MailPreview } from './google.js'

async function graph(store: Store, member: string | undefined, url: string, extraHeaders: Record<string, string> = {}): Promise<any | null> {
  const tok = await getToken(store, 'microsoft', member)
  if (!tok) return null
  const r = await fetch(url, { headers: { authorization: `Bearer ${tok}`, ...extraHeaders }, signal: AbortSignal.timeout(10_000) })
  if (!r.ok) return null
  return r.json()
}

/** Unread inbox mail, newest first. Null when not connected. */
export async function unreadOutlook(store: Store, member?: string, max = 5): Promise<MailPreview | null> {
  const d = await graph(store, member,
    `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$filter=isRead eq false&$top=${max}` +
    `&$select=from,subject,bodyPreview,receivedDateTime&$orderby=receivedDateTime desc&$count=true`,
    { ConsistencyLevel: 'eventual' })
  if (!d) return null
  const messages = (d.value || []).map((m: any) => ({
    from: String(m.from?.emailAddress?.name || m.from?.emailAddress?.address || ''),
    subject: String(m.subject || '(no subject)'),
    snippet: String(m.bodyPreview || '').slice(0, 140),
    date: String(m.receivedDateTime || ''),
    unread: true,
  }))
  return { total: Number(d['@odata.count'] ?? messages.length), messages }
}

/** Today's Outlook Calendar events. Null when not connected. */
export async function todaysOutlookEvents(store: Store, member?: string, now = new Date()): Promise<Array<{ time?: string; title: string }> | null> {
  const start = new Date(now); start.setHours(0, 0, 0, 0)
  const end = new Date(start.getTime() + 24 * 3600_000)
  const d = await graph(store, member,
    `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${encodeURIComponent(start.toISOString())}` +
    `&endDateTime=${encodeURIComponent(end.toISOString())}&$top=8&$select=subject,start,isAllDay&$orderby=start/dateTime`)
  if (!d) return null
  return (d.value || []).map((e: any) => ({
    title: String(e.subject || '(untitled)'),
    time: e.isAllDay ? undefined
      : new Date(String(e.start?.dateTime) + 'Z').toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
  }))
}
