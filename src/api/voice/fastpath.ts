/**
 * Voice fast-path (v0.2 §1): deterministic intents answered BEFORE the model.
 * The lesson from every LLM-assistant stumble of 2025-26: lights and timers
 * must never wait on (or be broken by) a language model. Target: transcript →
 * speech in under 300ms.
 *
 * Rules: a command matches only when the device resolves UNIQUELY against the
 * clean home set — any ambiguity falls through to the model. Lock/unlock is
 * deliberately excluded (confirm-class → the agent + approval card own it).
 * Every action leaves a receipt with an inverse, same as agent actions.
 */
import type { Store } from '../store/store.js'
import { log } from '../log.js'

const WORD_NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40,
  'forty five': 45, sixty: 60, ninety: 90,
}

function normalize(t: string): string {
  return t.toLowerCase()
    .replace(/[.,!?]+$/g, '')
    .replace(/^(hey orb[,!]?|orb[,!]?|please|could you|can you|would you)\s+/g, '')
    .replace(/\s+please$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function num(s: string): number | null {
  const n = Number(s)
  if (Number.isFinite(n)) return n
  return WORD_NUM[s] ?? null
}

/** Try to answer deterministically. Returns the spoken reply, or null to
 *  fall through to the model. */
export async function tryFastPath(store: Store, user: string, transcriptRaw: string): Promise<string | null> {
  const t = normalize(transcriptRaw)
  if (!t || t.length > 80) return null
  const started = Date.now()
  try {
    const reply = await match(store, user, t)
    if (reply) log.info('voice_fastpath', { t, ms: Date.now() - started })
    return reply
  } catch (e) {
    log.warn('voice_fastpath_error', { error: (e as Error).message })
    return null   // never let the fast-path break a turn
  }
}

async function match(store: Store, user: string, t: string): Promise<string | null> {
  // ── time & date ──
  if (/^what(?:'s| is) the time$|^what time is it$/.test(t)) {
    const d = new Date()
    return `It's ${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}.`
  }
  if (/^what(?:'s| is) (?:the date|today'?s date)$|^what day is it$/.test(t)) {
    return `It's ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}.`
  }

  // ── timers ──
  let m = t.match(/^(?:set|start) (?:a |the )?(?:(.+?) )?timer for ([\w ]+?) (seconds?|secs?|minutes?|mins?|hours?)$/)
  if (m) {
    const n = num(m[2]!)
    if (n == null || n <= 0) return null
    const unit = m[3]!.startsWith('h') ? 3600 : m[3]!.startsWith('s') ? 1 : 60
    const label = (m[1] || 'timer').trim()
    const { addTimer } = await import('../home/timers.js')
    await addTimer(store, label, Date.now() + n * unit * 1000, undefined, user)
    await receipt(store, user, `Set a ${label === 'timer' ? '' : label + ' '}timer for ${n} ${m[3]}`)
    return `${label === 'timer' ? 'Timer' : cap(label) + ' timer'} set — ${n} ${m[3]}.`
  }
  m = t.match(/^cancel (?:the )?(?:(.+?) )?timer$/)
  if (m) {
    const { listTimers, cancelTimer } = await import('../home/timers.js')
    const timers = await listTimers(store)
    if (!timers.length) return 'No timers running.'
    const label = (m[1] || '').trim()
    let target = label ? timers.find(x => x.label.toLowerCase().includes(label)) : (timers.length === 1 ? timers[0] : null)
    if (!target) return null                       // ambiguous → model
    await cancelTimer(store, target.id)
    await receipt(store, user, `Cancelled the ${target.label} timer`)
    return `${cap(target.label)} timer cancelled.`
  }

  // ── 
  // "catch me up" / "what happened while I was gone" → spoken digest (§11)
  if (/^(catch me up|what(’|')?s? happened|what did i miss|anything happen)/.test(t)) {
    try {
      const { listEvents, digest } = await import('../events/journal.js')
      const seenKey = `journal:seen:${user.replace(/^user:/, '')}`
      const lastSeen = Number(await store.getKv(seenKey).catch(() => null)) || (Date.now() - 8 * 3600_000)
      const events = await listEvents(store, { since: lastSeen, member: user.replace(/^user:/, '') })
      await store.putKv(seenKey, String(Date.now()), 0).catch(() => {})
      const d = digest(events)
      const top = events.slice(-3).map(e => e.summary).join('. ')
      return d.line + (top ? ' ' + top + '.' : '')
    } catch { /* fall through to the model */ }
  }

  // ── house check: "is the house okay/locked?" → instant status ──
  if (/^(is the house (ok(ay)?|locked|secure)|house check|is everything (ok(ay)?|locked|closed))\??$/.test(t)) {
    try {
      const { haEnabled, haStates } = await import('../connectors/homeAssistant.js')
      if (haEnabled()) {
        const [locks, bins] = [await haStates(['lock']), await haStates(['binary_sensor'])]
        const unlocked = locks.filter(l => l.state === 'unlocked').map(l => l.name)
        const open = bins.filter(b => ['door', 'window', 'garage_door', 'opening'].includes(String(b.attributes?.device_class)) && b.state === 'on').map(b => b.name)
        const { getMode } = await import('../home/mode.js')
        const mode = await getMode(store)
        if (!unlocked.length && !open.length) return `All good — house is ${mode}, everything locked and closed.`
        const bits = []
        if (unlocked.length) bits.push(`unlocked: ${unlocked.join(', ')}`)
        if (open.length) bits.push(`open: ${open.join(', ')}`)
        return `House is ${mode} — ${bits.join('; ')}.`
      }
    } catch { /* model fallback */ }
  }

  // ── house mode (non-secure only; secure is confirm-class → the agent) ──
  m = t.match(/^set (?:the )?house (?:mode )?to (home|away|vacation|guests?)$/)
    || t.match(/^(?:i'?m|we'?re) (leaving|heading out|home|back)$/)
  if (m) {
    const word = m[1]!
    const mode = word === 'guests' ? 'guest'
      : word === 'leaving' || word === 'heading out' ? 'away'
      : word === 'back' ? 'home' : word
    if (!['home', 'away', 'vacation', 'guest'].includes(mode)) return null
    const { getMode, setMode } = await import('../home/mode.js')
    const prior = await getMode(store)
    if (prior === mode) return `The house is already set to ${mode}.`
    await setMode(store, mode as any)
    await receipt(store, user, `Set the house to ${mode}`, { kind: 'mode', mode: prior })
    return `House mode: ${mode}.`
  }

  // ── undo ──
  if (/^undo (?:that|it|the last(?: one| action)?)$/.test(t)) {
    const { listReceipts, undoReceipt } = await import('../policy/policy.js')
    const last = (await listReceipts(store, 20)).find(r => r.inverse && !r.undone)
    if (!last) return 'Nothing recent can be undone automatically.'
    const done = await undoReceipt(store, last.id)
    return done ?? 'That one has no automatic inverse.'
  }

  // ── device control ──
  m = t.match(/^turn (on|off) (?:the )?(.+)$/) || t.match(/^turn (?:the )?(.+?) (on|off)$/)
  if (m) {
    const [action, name] = /^(on|off)$/.test(m[1]!) ? [m[1]!, m[2]!] : [m[2]!, m[1]!]
    return controlDevice(store, user, name, action)
  }
  m = t.match(/^(?:dim|set) (?:the )?(.+?) to (\d{1,3})(?: ?(?:percent|%))?$/)
  if (m) {
    const v = Number(m[2])
    if (v > 100) return null
    if (/volume/.test(m[1]!)) {
      const name = m[1]!.replace(/(?:the )?volume (?:on|of|in) (?:the )?/, '').trim()
      return controlDevice(store, user, name, 'set', v, ['media_player'])
    }
    return controlDevice(store, user, m[1]!, 'set', v, ['light'])
  }
  m = t.match(/^(open|close) (?:the )?(.+)$/)
  if (m) return controlDevice(store, user, m[2]!, m[1]!, undefined, ['cover'])

  return null
}

async function controlDevice(
  store: Store, user: string, name: string, action: string, value?: number,
  domains?: string[],
): Promise<string | null> {
  const { haEnabled, haStates, haResolve, haJoinAreas, haCallService, HOME_DOMAINS } = await import('../connectors/homeAssistant.js')
  if (!haEnabled()) return null
  const raw = await haStates(HOME_DOMAINS)
  // The clean (registry-filtered) set when the WS registry answers; raw
  // states otherwise — never let registry hiccups take the fast-path down.
  let all: typeof raw
  try { all = await haJoinAreas(raw) } catch { all = raw }
  const pool = domains ? all.filter(e => domains.includes(e.domain)) : all
  const matches = haResolve(pool, name)
  // Uniqueness is the safety rule: guessers break trust. An exact name match
  // wins outright; otherwise the fuzzy set must be a single device. Locks
  // never reach here (excluded from the usable domains).
  const usable = matches.filter(e => ['light', 'switch', 'fan', 'media_player', 'cover'].includes(e.domain))
  const exact = usable.filter(e => e.name.toLowerCase() === name.toLowerCase())
  const e = exact.length === 1 ? exact[0]! : (usable.length === 1 ? usable[0]! : null)
  if (!e) return null
  const { serviceFor } = await import('../home/routes.js')
  const plan = serviceFor(e.domain, action, value)
  if (!plan) return null
  // Capture the inverse BEFORE acting.
  const prior = e.state === 'on' || e.state === 'playing'
    ? { kind: 'home-control' as const, entity_id: e.entity_id, action: 'on', value: typeof e.attributes.brightness === 'number' ? Math.round((e.attributes.brightness / 255) * 100) : undefined }
    : { kind: 'home-control' as const, entity_id: e.entity_id, action: 'off' }
  await haCallService(e.domain, plan.service, e.entity_id, plan.data)
  const what = action === 'set' ? `${e.name} to ${value}${e.domain === 'media_player' ? '' : '%'}` : `${e.name} ${action}`
  const line = action === 'set' ? `Set ${what}` : cap(what)
  await receipt(store, user, action === 'set' ? line : `Turn ${what}`, prior)
  return `${line}.`
}

async function receipt(store: Store, user: string, summary: string, inverse?: any): Promise<void> {
  const { recordReceipt } = await import('../policy/policy.js')
  await recordReceipt(store, { user, tool: 'Voice', key: 'voice:fastpath', summary, inverse }).catch(() => { /* never block */ })
}

function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1) }
