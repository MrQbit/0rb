/**
 * Google data reads for the morning deck: unread Gmail + today's Calendar.
 * One OAuth connection (Settings → Apps → Google) lights up both — the
 * scopes are already requested by cloudStorageOAuth. Every function returns
 * null when Google isn't connected so callers can skip the card honestly.
 */
import type { Store } from '../store/store.js'
import { getToken } from './cloudStorageOAuth.js'

async function gapi(store: Store, url: string, member?: string): Promise<any | null> {
  const tok = await getToken(store, 'google', member)
  if (!tok) return null
  const r = await fetch(url, { headers: { authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(10_000) })
  if (!r.ok) return null
  return r.json()
}

export interface MailPreview {
  total: number
  messages: Array<{ from: string; subject: string; snippet: string; date: string; unread: boolean }>
}

/** Unread primary-inbox mail, newest first. Null when not connected. */
export async function unreadMail(store: Store, max = 5, member?: string): Promise<MailPreview | null> {
  const list = await gapi(store,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent('is:unread category:primary')}&maxResults=${max}`, member)
  if (!list) return null
  const ids: Array<{ id: string }> = list.messages || []
  const messages: MailPreview['messages'] = []
  for (const m of ids) {
    const d = await gapi(store,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, member)
    if (!d) continue
    const h = (name: string) => (d.payload?.headers || []).find((x: any) => x.name === name)?.value || ''
    messages.push({
      from: h('From').replace(/\s*<[^>]*>/, '').replace(/"/g, ''),
      subject: h('Subject') || '(no subject)',
      snippet: String(d.snippet || ''),
      date: h('Date'),
      unread: true,
    })
  }
  return { total: Number(list.resultSizeEstimate ?? messages.length), messages }
}

/** Today's Google Calendar events (primary calendar). Null when not connected. */
export async function todaysGoogleEvents(store: Store, now = new Date(), member?: string): Promise<Array<{ time?: string; title: string }> | null> {
  const start = new Date(now); start.setHours(0, 0, 0, 0)
  const end = new Date(start.getTime() + 24 * 3600_000)
  const d = await gapi(store,
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime` +
    `&timeMin=${encodeURIComponent(start.toISOString())}&timeMax=${encodeURIComponent(end.toISOString())}&maxResults=8`, member)
  if (!d) return null
  return (d.items || []).map((e: any) => ({
    title: String(e.summary || '(untitled)'),
    time: e.start?.dateTime
      ? new Date(e.start.dateTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      : undefined,   // all-day
  }))
}
