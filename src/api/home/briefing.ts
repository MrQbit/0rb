/**
 * Morning briefing — the day at a glance, assembled from what Orb already
 * knows: weather at home, the family calendar, open chores, running timers,
 * security state, who's home. Delivered on a schedule (ORB2_BRIEFING_TIME,
 * e.g. "07:30"; unset = off) to the owner's channels, and available any
 * time via the agent (Family op:'briefing') as a widget.
 */
import type { Store } from '../store/store.js'
import { haEnabled, haStates, haJoinAreas } from '../connectors/homeAssistant.js'
import { weather } from '../connectors/geo.js'
import { log } from '../log.js'

export interface Briefing {
  date: string
  weather?: { location: string; temp: number; condition: string; high: number; low: number }
  events: Array<{ time?: string; title: string; who?: string }>
  chores: Array<{ title: string; who: string }>
  timers: Array<{ label: string; minutesLeft: number }>
  security: { locksOpen: string[]; sensorsOpen: string[] }
  home: string[]
  away: string[]
}

export async function buildBriefing(store: Store): Promise<Briefing> {
  const today = new Date().toISOString().slice(0, 10)
  const out: Briefing = { date: today, events: [], chores: [], timers: [], security: { locksOpen: [], sensorsOpen: [] }, home: [], away: [] }

  // Weather (best-effort — home location resolves via HA coordinates).
  try {
    const loc = (process.env.ORB2_HOME_LOCATION || '').trim()
    if (loc) {
      const w = await weather(loc)
      if (w) out.weather = { location: w.location, temp: w.current.temp, condition: w.current.condition, high: w.forecast[0]?.high ?? w.current.temp, low: w.forecast[0]?.low ?? w.current.temp }
    }
  } catch { /* skip */ }

  // Family calendar: today's events.
  try {
    const { listEvents } = await import('../family/family.js')
    out.events = (await listEvents(store)).filter(e => e.date === today).map(e => ({ time: e.time, title: e.title, who: e.who }))
  } catch { /* skip */ }

  // Open chores.
  try {
    const { listChores, memberName } = await import('../family/family.js')
    const open = (await listChores(store)).filter(c => !c.done && (c.day === undefined || c.day === new Date().getDay()))
    out.chores = await Promise.all(open.map(async c => ({ title: c.title, who: await memberName(store, c.who) })))
  } catch { /* skip */ }

  // Running timers.
  try {
    const { listTimers } = await import('./timers.js')
    out.timers = (await listTimers(store)).map(t => ({ label: t.label.replace(/ → .*$/, ''), minutesLeft: Math.max(0, Math.round((t.at - Date.now()) / 60_000)) }))
  } catch { /* skip */ }

  // Security + presence, when HA is up.
  if (haEnabled()) {
    try {
      const [locks, bins, people] = await Promise.all([
        haJoinAreas(await haStates(['lock'])),
        haJoinAreas(await haStates(['binary_sensor'])),
        haStates(['person']),
      ])
      out.security.locksOpen = locks.filter(l => l.state !== 'locked').map(l => l.name)
      out.security.sensorsOpen = bins
        .filter(b => ['door', 'window', 'garage_door', 'opening'].includes(b.attributes.device_class) && b.state === 'on')
        .map(b => b.name)
      for (const p of people) (p.state === 'home' ? out.home : out.away).push(p.name)
    } catch { /* skip */ }
  }
  return out
}

/** The briefing as a warm one-paragraph text (for Telegram/push/voice). */
export function briefingText(b: Briefing): string {
  const bits: string[] = []
  if (b.weather) bits.push(`${b.weather.condition.toLowerCase()}, ${b.weather.temp}° now (high ${b.weather.high}°, low ${b.weather.low}°)`)
  if (b.events.length) bits.push(`today: ${b.events.map(e => `${e.time ? e.time + ' ' : ''}${e.title}`).join(', ')}`)
  if (b.chores.length) bits.push(`chores: ${b.chores.map(c => `${c.title} (${c.who})`).join(', ')}`)
  const sec = [...b.security.locksOpen.map(l => `${l} unlocked`), ...b.security.sensorsOpen.map(s => `${s} open`)]
  if (sec.length) bits.push(`heads up: ${sec.join(', ')}`)
  if (!bits.length) bits.push('clear calendar, nothing needing attention')
  return `☀️ Good morning! ${bits.join(' · ')}.`
}

export function briefingWidgetSpec(b: Briefing): any {
  return { id: 'briefing', type: 'briefing', title: 'Today', briefing: b }
}

let lastSent = ''

/** Called from the proactive tick: fire once when the clock passes the mark. */
export async function maybeSendBriefing(store: Store, notify: (t: string) => Promise<void>): Promise<void> {
  const at = (process.env.ORB2_BRIEFING_TIME || '').trim()
  if (!/^\d{1,2}:\d{2}$/.test(at)) return
  const now = new Date()
  const [h, m] = at.split(':').map(Number)
  const today = now.toISOString().slice(0, 10)
  if (lastSent === today) return
  if (now.getHours() > h! || (now.getHours() === h! && now.getMinutes() >= m!)) {
    lastSent = today
    try {
      const b = await buildBriefing(store)
      await notify(briefingText(b))
      log.info('briefing_sent', { date: today })
    } catch (err) { log.warn('briefing_failed', { error: (err as Error).message }) }
  }
}
