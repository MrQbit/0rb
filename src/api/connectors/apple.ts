/**
 * Apple integration. Apple has no OAuth API for consumer iCloud data —
 * Sign in with Apple is identity-only. The honest, supported path is an
 * APP-SPECIFIC PASSWORD (appleid.apple.com → Sign-In and Security →
 * App-Specific Passwords): one credential lights up iCloud Calendar via
 * CalDAV today (Contacts/Reminders ride the same credential later).
 *
 * Credentials are per member, verified against caldav.icloud.com before
 * being stored; the calendar-home URL is discovered once and cached.
 */
import type { Store } from '../store/store.js'
import { log } from '../log.js'

const CRED_KEY = (member: string) => `apple:cred:${member}`
const CALDAV = 'https://caldav.icloud.com'

interface AppleCred { appleId: string; appPassword: string; home?: string }

function basic(c: AppleCred): string {
  return 'Basic ' + Buffer.from(`${c.appleId}:${c.appPassword}`).toString('base64')
}

async function dav(c: AppleCred, url: string, method: string, depth: string, body: string): Promise<string | null> {
  const r = await fetch(url, {
    method,
    headers: { authorization: basic(c), depth, 'content-type': 'application/xml; charset=utf-8' },
    body,
    signal: AbortSignal.timeout(15_000),
  })
  if (r.status === 401 || r.status === 403) throw new Error('unauthorized')
  if (!r.ok && r.status !== 207) return null
  return r.text()
}

const href = (xml: string): string | null => xml.match(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/i)?.[1] ?? null

/** Discover the account's calendar-home-set URL. Throws 'unauthorized' on bad creds. */
async function discoverHome(c: AppleCred): Promise<string | null> {
  const q = (prop: string) => `<?xml version="1.0"?><propfind xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><prop>${prop}</prop></propfind>`
  const p1 = await dav(c, `${CALDAV}/`, 'PROPFIND', '0', q('<current-user-principal/>'))
  const principal = p1 && href(p1.split('current-user-principal')[1] || '')
  if (!principal) return null
  const p2 = await dav(c, `${CALDAV}${principal}`, 'PROPFIND', '0', q('<c:calendar-home-set/>'))
  const home = p2 && href(p2.split('calendar-home-set')[1] || '')
  return home ? (home.startsWith('http') ? home : `${CALDAV}${home}`) : null
}

export async function appleConnected(store: Store, member: string): Promise<boolean> {
  return !!(await store.getKv(CRED_KEY(member)).catch(() => null))
}

/** Verify against iCloud, then store. Throws with an honest message on failure. */
export async function connectApple(store: Store, member: string, appleId: string, appPassword: string): Promise<void> {
  const c: AppleCred = { appleId: appleId.trim(), appPassword: appPassword.trim() }
  if (!c.appleId.includes('@') || c.appPassword.length < 8) throw new Error('an Apple ID email and an app-specific password are required')
  let home: string | null
  try { home = await discoverHome(c) } catch {
    throw new Error('iCloud rejected that sign-in. Use an APP-SPECIFIC password (appleid.apple.com → Sign-In and Security → App-Specific Passwords) — your normal Apple ID password will not work here.')
  }
  if (!home) throw new Error('signed in, but no iCloud calendar home was found for that Apple ID')
  await store.putKv(CRED_KEY(member), JSON.stringify({ ...c, home }), 0)
  log.info('apple_connected', { member })
}

export async function disconnectApple(store: Store, member: string): Promise<void> {
  await store.delKv(CRED_KEY(member)).catch(() => {})
}

/** Today's iCloud Calendar events across the account's calendars. Null when not connected. */
export async function todaysAppleEvents(store: Store, member: string, now = new Date()): Promise<Array<{ time?: string; title: string }> | null> {
  let c: AppleCred
  try { c = JSON.parse((await store.getKv(CRED_KEY(member))) || 'null') } catch { return null }
  if (!c?.home) return null
  const start = new Date(now); start.setHours(0, 0, 0, 0)
  const end = new Date(start.getTime() + 24 * 3600_000)
  const fmt = (d: Date) => d.toISOString().replace(/[-:]|\.\d{3}/g, '')
  // Enumerate calendar collections under home, then time-range query each.
  const list = await dav(c, c.home, 'PROPFIND', '1',
    '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>').catch(() => null)
  if (!list) return null
  const cals = [...list.matchAll(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/gi)]
    .map(m => m[1]!)
    .filter(u => u !== new URL(c.home!).pathname && u.endsWith('/'))
    .slice(0, 6)
  const events: Array<{ time?: string; title: string; ts: number }> = []
  for (const cal of cals) {
    const url = cal.startsWith('http') ? cal : `${CALDAV}${cal}`
    const rep = await dav(c, url, 'REPORT', '1',
      `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">` +
      `<d:prop><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">` +
      `<c:time-range start="${fmt(start)}" end="${fmt(end)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`).catch(() => null)
    if (!rep) continue
    for (const ev of parseVevents(rep)) {
      if (ev.ts >= start.getTime() && ev.ts < end.getTime()) events.push(ev)
    }
  }
  events.sort((a, b) => a.ts - b.ts)
  return events.slice(0, 8).map(({ time, title }) => ({ time, title }))
}

/** Minimal VEVENT extraction: SUMMARY + DTSTART (date or datetime). */
export function parseVevents(icsBlob: string): Array<{ time?: string; title: string; ts: number }> {
  const out: Array<{ time?: string; title: string; ts: number }> = []
  // ics arrives XML-escaped inside calendar-data; unescape the essentials
  const text = icsBlob.replace(/&#13;/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  for (const block of text.split('BEGIN:VEVENT').slice(1)) {
    const body = block.split('END:VEVENT')[0] || ''
    const summary = body.match(/\nSUMMARY(?:;[^:\n]*)?:(.*)/)?.[1]?.trim().replace(/\\,/g, ',')
    const dt = body.match(/\nDTSTART(?:;[^:\n]*)?:(\d{8})(?:T(\d{6})(Z?))?/)
    if (!summary || !dt) continue
    const [, ymd, hms, z] = dt
    const iso = `${ymd!.slice(0, 4)}-${ymd!.slice(4, 6)}-${ymd!.slice(6, 8)}` +
      (hms ? `T${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4, 6)}${z || ''}` : 'T00:00:00')
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) continue
    out.push({
      title: summary,
      time: hms ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : undefined,
      ts: d.getTime(),
    })
  }
  return out
}
