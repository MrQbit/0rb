/**
 * The morning deck (v0.2 §3) — a proactive digest done the calm way: a
 * per-member card stack assembled overnight from LIVE household data (no
 * model call needed), delivered when the member first shows up after 05:30
 * — never as a push. Per-card thumbs write back into a topic score that
 * reorders (and eventually drops) topics the member doesn't care about.
 */
import type { Store } from '../store/store.js'
import { log } from '../log.js'

export interface DeckCard { topic: string; spec: any }

const FEEDBACK_KEY = (u: string) => `deck:feedback:${u}`
const READY_KEY = (u: string) => `deck:ready:${u}`
const DROP_BELOW = -4

export async function topicScores(store: Store, user: string): Promise<Record<string, number>> {
  try { return JSON.parse((await store.getKv(FEEDBACK_KEY(user))) || '{}') } catch { return {} }
}

export async function recordFeedback(store: Store, user: string, topic: string, delta: number): Promise<void> {
  const s = await topicScores(store, user)
  s[topic] = (s[topic] ?? 0) + (delta > 0 ? 1 : -2)
  await store.putKv(FEEDBACK_KEY(user), JSON.stringify(s), 0)
}

/** Assemble the deck from live sources; ordered by the member's topic
 *  scores, topics driven below the floor are dropped entirely. */
export async function assembleDeck(store: Store, user: string, now = new Date()): Promise<DeckCard[]> {
  const cards: DeckCard[] = []
  const today = now.toISOString().slice(0, 10)

  // Today's calendar.
  try {
    const { listEvents, nextOccurrence } = await import('../family/family.js')
    const events = (await listEvents(store))
      .map(e => ({ ...e, next: e.repeat === 'yearly' ? nextOccurrence(e.date, today) : e.date }))
      .filter(e => e.next === today)
      .map(e => ({ time: e.time || '—', title: e.title, who: e.who }))
    if (events.length) {
      cards.push({ topic: 'calendar', spec: { id: 'deck-cal', type: 'familyboard', title: 'Today', notes: [], events: events.map(e => ({ date: today, time: e.time, title: e.title, who: e.who })) } })
    }
  } catch { /* optional */ }

  // House anomalies: open doors/windows, low batteries, unavailable devices.
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

  // Open threads: waiting notes for this member + timers still running.
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

  // Chores due today (this member's first).
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

  // Presence snapshot (who's already up/out).
  try {
    const { listPresence } = await import('../presence/presence.js')
    const people = await listPresence(store)
    if (people.length) cards.push({ topic: 'presence', spec: { id: 'deck-presence', type: 'presence', title: "Who's home", people: people.map(p => ({ name: p.name, home: p.home })) } })
  } catch { /* optional */ }

  // Order by learned preference; drop what the member keeps thumbing down.
  const scores = await topicScores(store, user)
  return cards
    .filter(c => (scores[c.topic] ?? 0) > DROP_BELOW)
    .sort((a, b) => (scores[b.topic] ?? 0) - (scores[a.topic] ?? 0))
}

/** Nightly assembly for every member — called from the proactive scheduler. */
export async function assembleDaily(store: Store, now = new Date()): Promise<number> {
  const today = now.toISOString().slice(0, 10)
  let built = 0
  try {
    const { getUsers } = await import('../auth/otp.js')
    for (const u of await getUsers(store)) {
      const existing = await store.getKv(READY_KEY(u.email))
      if (existing && JSON.parse(existing).date === today) continue
      const cards = await assembleDeck(store, u.email, now)
      if (!cards.length) continue
      await store.putKv(READY_KEY(u.email), JSON.stringify({ date: today, cards, seen: false }), 0)
      built++
      log.info('deck_assembled', { user: u.email, cards: cards.length })
    }
  } catch (e) { log.warn('deck_assembly_failed', { error: (e as Error).message }) }
  return built
}

/** The member's deck for today, if assembled and not yet dismissed. */
export async function todaysDeck(store: Store, user: string, now = new Date()): Promise<any | null> {
  const raw = await store.getKv(READY_KEY(user))
  if (!raw) return null
  try {
    const d = JSON.parse(raw)
    if (d.date !== now.toISOString().slice(0, 10) || d.dismissed) return null
    return { id: `deck-${now.getTime() % 100000}`, type: 'deck', title: 'Good morning', cards: d.cards }
  } catch { return null }
}

export async function dismissDeck(store: Store, user: string): Promise<void> {
  const raw = await store.getKv(READY_KEY(user))
  if (!raw) return
  try {
    const d = JSON.parse(raw)
    d.dismissed = true
    await store.putKv(READY_KEY(user), JSON.stringify(d), 0)
  } catch { /* ignore */ }
}
