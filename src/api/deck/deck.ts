/**
 * The morning deck (v0.2 §3) — a proactive digest done the calm way.
 *
 * Delivered ONCE per day, on the first time orb is used after LOCAL SUNRISE
 * (home coordinates from ORB2_HOME_LOCATION or Home Assistant; 06:30 local
 * as the no-location fallback). Assembled FRESH at that moment — weather and
 * news at 3am are stale by breakfast.
 *
 * The default flow is weather → news → unread mail → calendar, plus the
 * house topics (anomalies, open threads, chores, who's home). Each member
 * picks their own mix in the deck's Customize view (kv deck:topics:<user>);
 * per-card thumbs still reorder within it and drop topics driven below the
 * floor. Topics without a source (no Google connected, no location) skip
 * silently — the Customize view names what they need.
 */
import type { Store } from '../store/store.js'
import { log } from '../log.js'

export interface DeckCard { topic: string; spec: any }

const FEEDBACK_KEY = (u: string) => `deck:feedback:${u}`
const READY_KEY = (u: string) => `deck:ready:${u}`
const TOPICS_KEY = (u: string) => `deck:topics:${u}`
const GEO_KEY = 'deck:geo'
const DROP_BELOW = -4

export const DECK_TOPICS: Array<{ id: string; label: string; desc: string }> = [
  { id: 'weather', label: 'Weather', desc: 'today at home + the week' },
  { id: 'news', label: 'News', desc: 'a few headlines' },
  { id: 'mail', label: 'Unread mail', desc: 'every inbox you have connected' },
  { id: 'calendar', label: 'Calendar', desc: 'today — family + your connected calendars' },
  { id: 'house', label: 'House', desc: 'open doors, low batteries' },
  { id: 'threads', label: 'Open threads', desc: 'notes waiting, timers running' },
  { id: 'chores', label: 'Chores', desc: 'due today, yours first' },
  { id: 'presence', label: "Who's home", desc: 'people in and out' },
]

// ── per-member topic choice ──────────────────────────────────────────────
export async function enabledTopics(store: Store, user: string): Promise<string[]> {
  try {
    const raw = await store.getKv(TOPICS_KEY(user))
    if (raw) {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) return arr.filter(t => DECK_TOPICS.some(d => d.id === t))
    }
  } catch { /* default below */ }
  return DECK_TOPICS.map(t => t.id)   // everything on until the member says otherwise
}

export async function setEnabledTopics(store: Store, user: string, enabled: string[]): Promise<string[]> {
  const clean = enabled.filter(t => DECK_TOPICS.some(d => d.id === t))
  await store.putKv(TOPICS_KEY(user), JSON.stringify(clean), 0)
  return clean
}

/** Topic list + availability notes for the Customize view. */
export async function topicsView(store: Store, user: string): Promise<any[]> {
  const on = new Set(await enabledTopics(store, user))
  const coords = await homeCoords(store)
  const { connectedProviders } = await import('../accounts/hub.js')
  const acc = await connectedProviders(store, user)
  const anyMail = acc.google || acc.microsoft
  const searx = !!(process.env.ORB2_SEARXNG_URL || '').trim()
  return DECK_TOPICS.map(t => ({
    ...t,
    enabled: on.has(t.id),
    available: t.id === 'weather' ? !!coords : t.id === 'news' ? searx : t.id === 'mail' ? anyMail : true,
    needs: t.id === 'weather' && !coords ? 'a home location (Settings → General)'
      : t.id === 'mail' && !anyMail ? 'a connected Google or Microsoft account (Settings → Apps)'
      : t.id === 'news' && !searx ? 'the search service' : undefined,
  }))
}

// ── where home is, and when the sun rises there ──────────────────────────
async function homeCoords(store: Store): Promise<{ lat: number; lng: number; name: string } | null> {
  try {
    const raw = await store.getKv(GEO_KEY)
    if (raw) { const c = JSON.parse(raw); if (c && Date.now() - c.ts < 24 * 3600_000) return c }
  } catch { /* refresh */ }
  let out: { lat: number; lng: number; name: string } | null = null
  const loc = (process.env.ORB2_HOME_LOCATION || '').trim()
  if (loc) {
    try {
      const { geocode } = await import('../connectors/geo.js')
      const g = await geocode(loc)
      if (g) out = { lat: g.lat, lng: g.lng, name: g.name?.split(',').slice(0, 2).join(',').trim() || loc }
    } catch { /* HA below */ }
  }
  if (!out) {
    try {
      const { haEnabled, haConfig } = await import('../connectors/homeAssistant.js')
      if (haEnabled()) {
        const c: any = await haConfig()
        if (c && Number.isFinite(c.latitude) && Number.isFinite(c.longitude)) {
          out = { lat: c.latitude, lng: c.longitude, name: String(c.location_name || 'Home') }
        }
      }
    } catch { /* none */ }
  }
  if (out) await store.putKv(GEO_KEY, JSON.stringify({ ...out, ts: Date.now() }), 0).catch(() => {})
  return out
}

/** Local sunrise as a UTC instant (NOAA approximation). Null in polar edge cases. */
export function sunriseToday(lat: number, lng: number, now = new Date()): Date | null {
  const rad = Math.PI / 180
  const doy = Math.floor((now.getTime() - Date.UTC(now.getUTCFullYear(), 0, 0)) / 86400_000)
  const gamma = (2 * Math.PI / 365) * (doy - 1)
  const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma))
  const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma)
  const cosHa = Math.cos(90.833 * rad) / (Math.cos(lat * rad) * Math.cos(decl)) - Math.tan(lat * rad) * Math.tan(decl)
  if (cosHa > 1 || cosHa < -1) return null
  const ha = Math.acos(cosHa) / rad
  const minutesUTC = 720 - 4 * (lng + ha) - eqtime
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + minutesUTC * 60_000)
}

async function pastSunrise(store: Store, now = new Date()): Promise<boolean> {
  const c = await homeCoords(store)
  if (c) {
    const rise = sunriseToday(c.lat, c.lng, now)
    if (rise) return now.getTime() >= rise.getTime()
  }
  // No location: a calm fixed default — 06:30 in the server's local time.
  const local = new Date(now)
  return local.getHours() > 6 || (local.getHours() === 6 && local.getMinutes() >= 30)
}

// ── feedback (unchanged mechanics) ───────────────────────────────────────
export async function topicScores(store: Store, user: string): Promise<Record<string, number>> {
  try { return JSON.parse((await store.getKv(FEEDBACK_KEY(user))) || '{}') } catch { return {} }
}

export async function recordFeedback(store: Store, user: string, topic: string, delta: number): Promise<void> {
  const s = await topicScores(store, user)
  s[topic] = (s[topic] ?? 0) + (delta > 0 ? 1 : -2)
  await store.putKv(FEEDBACK_KEY(user), JSON.stringify(s), 0)
}

// ── card builders ────────────────────────────────────────────────────────
async function prettyPeople(store: Store, people: Array<{ name: string; home: boolean }>): Promise<Array<{ name: string; home: boolean }>> {
  // Presence tracks role-ish keys ("owner"); show the person's actual name.
  let users: any[] = []
  try { const { getUsers } = await import('../auth/otp.js'); users = await getUsers(store) } catch { /* raw */ }
  const nice = (raw: string): string => {
    const key = raw.toLowerCase()
    const u = users.find(x => x.email === key || (x.label || '').toLowerCase() === key)
      || (key === 'owner' ? users.find(x => x.role === 'owner') : undefined)
    const base = (u?.label && u.label.toLowerCase() !== 'owner' ? u.label : '') || (u?.email || raw).split('@')[0]!
    return base.charAt(0).toUpperCase() + base.slice(1)
  }
  return people.map(p => ({ ...p, name: nice(p.name) }))
}

export async function assembleDeck(store: Store, user: string, now = new Date()): Promise<DeckCard[]> {
  const cards: DeckCard[] = []
  const today = now.toISOString().slice(0, 10)
  const enabled = new Set(await enabledTopics(store, user))

  if (enabled.has('weather')) {
    try {
      const c = await homeCoords(store)
      if (c) {
        const { weatherAt } = await import('../connectors/geo.js')
        const w = await weatherAt(c.lat, c.lng, c.name)
        if (w) cards.push({ topic: 'weather', spec: { id: 'deck-wx', type: 'weather', title: 'Weather', location: w.location, unit: 'F', current: w.current, forecast: w.forecast.slice(0, 5) } })
      }
    } catch { /* optional */ }
  }

  if (enabled.has('news')) {
    try {
      const base = (process.env.ORB2_SEARXNG_URL || '').replace(/\/+$/, '')
      if (base) {
        const r = await fetch(`${base}/search?q=${encodeURIComponent('top news today')}&categories=news&format=json`, { signal: AbortSignal.timeout(10_000) })
        if (r.ok) {
          const d = (await r.json()) as any
          const items = (d.results || []).slice(0, 6).map((x: any) => ({
            title: String(x.title || '').slice(0, 120),
            subtitle: (() => { try { return new URL(x.url).hostname.replace(/^www\./, '') } catch { return '' } })(),
            url: String(x.url || ''),
          })).filter((x: any) => x.title && x.url)
          if (items.length) cards.push({ topic: 'news', spec: { id: 'deck-news', type: 'results', title: 'This morning', items } })
        }
      }
    } catch { /* optional */ }
  }

  if (enabled.has('mail')) {
    try {
      const { unreadMailAll } = await import('../accounts/hub.js')
      const mail = await unreadMailAll(store, user, 5)
      if (mail && mail.messages.length) {
        cards.push({ topic: 'mail', spec: { id: 'deck-mail', type: 'mail', title: `Unread mail`, pill: `${mail.total} unread · ${mail.providers.join(' + ')}`, messages: mail.messages } })
      }
    } catch { /* optional */ }
  }

  if (enabled.has('calendar')) {
    try {
      const events: Array<{ date: string; time?: string; title: string; who?: string }> = []
      try {
        const { listEvents, nextOccurrence } = await import('../family/family.js')
        for (const e of await listEvents(store)) {
          const next = e.repeat === 'yearly' ? nextOccurrence(e.date, today) : e.date
          if (next === today) events.push({ date: today, time: e.time || undefined, title: e.title, who: e.who })
        }
      } catch { /* family optional */ }
      try {
        const { todaysEventsAll } = await import('../accounts/hub.js')
        const g = await todaysEventsAll(store, user, now)
        for (const e of g || []) events.push({ date: today, time: e.time, title: e.title })
      } catch { /* providers optional */ }
      if (events.length) cards.push({ topic: 'calendar', spec: { id: 'deck-cal', type: 'familyboard', title: 'Today', notes: [], events } })
    } catch { /* optional */ }
  }

  if (enabled.has('house')) {
    try {
      const { haEnabled, haStates } = await import('../connectors/homeAssistant.js')
      if (haEnabled()) {
        const bins = await haStates(['binary_sensor', 'sensor'])
        const open = bins.filter(s => ['door', 'window', 'opening', 'garage_door'].includes(String(s.attributes.device_class)) && s.state === 'on')
        const lowBatt = bins.filter(s => String(s.attributes.device_class) === 'battery' && Number.isFinite(Number(s.state)) && Number(s.state) <= 15)
        const rows = [
          ...open.map(s => ({ name: `${s.name} is open`, state: '', on: true })),
          ...lowBatt.map(s => ({ name: `${s.name} battery low`, state: `${s.state}%`, on: false })),
        ]
        if (rows.length) cards.push({ topic: 'house', spec: { id: 'deck-house', type: 'home', title: 'Worth a look', devices: rows.map((r, i) => ({ entity_id: `deck-${i}`, name: r.name, domain: 'sensor', kind: '', state: r.state, on: r.on, area: '', controllable: false, sub: '' })) } })
      }
    } catch { /* optional */ }
  }

  if (enabled.has('threads')) {
    try {
      const { listNotes } = await import('../family/family.js')
      const waiting = (await listNotes(store)).filter(n => !n.delivered && n.to === user)
      const { listTimers } = await import('../home/timers.js')
      const timers = await listTimers(store)
      if (waiting.length || timers.length) {
        cards.push({ topic: 'threads', spec: { id: 'deck-threads', type: 'note', title: 'Open threads',
          text: [
            ...waiting.map(n => `Note waiting from ${n.from}: “${n.text}”`),
            ...timers.map(t => `Timer running: ${t.label}`),
          ].join('\n') } })
      }
    } catch { /* optional */ }
  }

  if (enabled.has('chores')) {
    try {
      const { listChores } = await import('../family/family.js')
      const day = now.getDay()
      const due = (await listChores(store)).filter((c: any) => c.day == null || c.day === day)
      if (due.length) {
        const mine = due.filter((c: any) => (c.who || '').toLowerCase().includes(user.split('@')[0]!.toLowerCase()))
        const rest = due.filter((c: any) => !mine.includes(c))
        cards.push({ topic: 'chores', spec: { id: 'deck-chores', type: 'todo', title: 'Chores today',
          items: [...mine, ...rest].slice(0, 8).map((c: any) => ({ content: `${c.title} — ${c.who}`, status: c.doneOn === today ? 'completed' : 'pending' })) } })
      }
    } catch { /* optional */ }
  }

  if (enabled.has('presence')) {
    try {
      const { listPresence } = await import('../presence/presence.js')
      const people = await listPresence(store)
      if (people.length) {
        const pretty = await prettyPeople(store, people.map(p => ({ name: p.name, home: p.home })))
        cards.push({ topic: 'presence', spec: { id: 'deck-presence', type: 'presence', title: "Who's home", people: pretty } })
      }
    } catch { /* optional */ }
  }

  // Order by learned preference; drop what the member keeps thumbing down.
  const scores = await topicScores(store, user)
  return cards
    .filter(c => (scores[c.topic] ?? 0) > DROP_BELOW)
    .sort((a, b) => (scores[b.topic] ?? 0) - (scores[a.topic] ?? 0))
}

// ── delivery: once, on first use after sunrise ───────────────────────────
export async function todaysDeck(store: Store, user: string, now = new Date(), force = false): Promise<any | null> {
  const today = now.toISOString().slice(0, 10)
  if (!force) {
    try {
      const d = JSON.parse((await store.getKv(READY_KEY(user))) || 'null')
      if (d && d.date === today && (d.seen || d.dismissed)) return null
    } catch { /* fresh below */ }
    if (!(await pastSunrise(store, now))) return null
  }
  const cards = await assembleDeck(store, user, now)
  if (!cards.length) return null
  await store.putKv(READY_KEY(user), JSON.stringify({ date: today, seen: true, cards }), 0).catch(() => {})
  log.info('deck_delivered', { user, cards: cards.length, force })
  return { id: `deck-${now.getTime() % 100000}`, type: 'deck', title: 'Good morning', cards }
}

export async function dismissDeck(store: Store, user: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  await store.putKv(READY_KEY(user), JSON.stringify({ date: today, seen: true, dismissed: true }), 0).catch(() => {})
}
