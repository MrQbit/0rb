/**
 * Proactive home watcher — the part that makes Orb feel like it *is* the house.
 *
 * Polls Home Assistant on a timer and, when something needs attention, pings
 * the owner on their channel in Orb's voice: a door/window/garage left open too
 * long, or a lock left unlocked. Cheap rule-based triggers (no LLM per event),
 * debounced so you get one nudge per situation, cleared when it's resolved.
 *
 * Config:
 *   ORB2_HOME_PROACTIVE        '0' to disable (default on when HA configured)
 *   ORB2_HOME_WATCH_SECONDS    poll interval (default 60)
 *   ORB2_HOME_OPEN_ALERT_MIN   minutes open/unlocked before a nudge (default 10)
 *
 * Notifications go to Telegram (ORB2_TELEGRAM_BOT_TOKEN + _OWNER_ID) when set;
 * otherwise they're logged (and surface in the audit trail).
 */
import { haEnabled, haStates, haDiscoveredFlows, type HaEntity } from '../connectors/homeAssistant.js'
import { sendPush } from '../push/fcm.js'
import type { Store } from '../store/store.js'
import { log } from '../log.js'

let pushStore: Store | null = null

let timer: ReturnType<typeof setInterval> | null = null
/** entity_id → epoch ms when it first entered the "needs watching" state. */
const since = new Map<string, number>()
/** entity_ids we've already nudged about (cleared when they resolve). */
const alerted = new Set<string>()

function enabled(): boolean {
  return haEnabled() && process.env.ORB2_HOME_PROACTIVE !== '0'
}
function intervalMs(): number {
  return Math.max(10, Number(process.env.ORB2_HOME_WATCH_SECONDS || 60)) * 1000
}
function thresholdMs(): number {
  return Math.max(0, Number(process.env.ORB2_HOME_OPEN_ALERT_MIN ?? 10)) * 60_000
}

/** Is this entity in a state Orb should keep an eye on? Returns a label or null. */
function watchState(e: HaEntity, motion = false): string | null {
  if (e.domain === 'lock' && e.state === 'unlocked') return 'unlocked'
  if (e.domain === 'binary_sensor') {
    const cls = e.attributes?.device_class
    if (['door', 'window', 'garage_door', 'opening'].includes(cls) && e.state === 'on') return 'open'
    if (motion && ['motion', 'occupancy'].includes(cls) && e.state === 'on') return 'motion'
  }
  if (e.domain === 'cover' && e.state === 'open' && e.attributes?.device_class === 'garage') return 'open'
  return null
}

/** A warm, brief, Orb-voice nudge. */
function phrase(e: HaEntity, label: string, mins: number): string {
  const m = Math.round(mins)
  const dur = m >= 60 ? `${Math.round(m / 60)}h` : `${m} min`
  if (label === 'unlocked') return `Heads up — the ${e.name} has been unlocked for ${dur}. Want me to lock it?`
  if (label === 'motion') return `⚠️ Motion at the ${e.name} — and the house is set to away.`
  return `Heads up — the ${e.name} has been open for ${dur}.`
}

export async function notifyOwner(text: string): Promise<void> {
  let delivered = false

  // Push to the 0rb apps (lock-screen notification, even when closed).
  if (pushStore) {
    try { await sendPush(pushStore, '0rb', text, { kind: 'home_alert' }); delivered = true } catch { /* best effort */ }
  }

  // Telegram, if configured.
  const token = process.env.ORB2_TELEGRAM_BOT_TOKEN
  const chatId = process.env.ORB2_TELEGRAM_OWNER_ID
  if (token && chatId) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      })
      log.info('home_alert_sent', { channel: 'telegram', text })
      delivered = true
    } catch (err) {
      log.warn('home_alert_send_failed', { error: (err as Error).message })
    }
  }

  // Always record it (and it's the only surface if nothing's configured).
  if (!delivered) log.info('home_alert', { text })
}

// ── Discovery watcher: "I found a new device on your network" ──────────
// HA discovers devices via mDNS/SSDP and parks them in a pending-flows
// queue that nobody looks at. Orb checks it and tells the owner, who can
// then just SAY "set it up" — the agent drives the pairing (HomeAdmin).
const SEEN_KEY = 'home:discovery:seen'
const seenFlows = new Set<string>()
let seenLoaded = false
let discoveryTicks = 0

/** Friendly names for common discovery handlers. */
const NICE: Record<string, string> = {
  webostv: 'an LG webOS TV', roomba: 'an iRobot Roomba', sonos: 'a Sonos speaker',
  hue: 'a Philips Hue bridge', cast: 'a Google Cast device', esphome: 'an ESPHome device',
  homekit_controller: 'a HomeKit device', shelly: 'a Shelly device', tplink: 'a TP-Link device',
  ipp: 'a network printer', brother: 'a Brother printer', wled: 'a WLED light controller',
  zwave_js: 'a Z-Wave controller', zha: 'a Zigbee controller', matter: 'a Matter device',
}
function nice(handler: string): string { return NICE[handler] || `a "${handler}" device` }

async function checkDiscoveries(): Promise<void> {
  const flows = await haDiscoveredFlows().catch(() => [] as Awaited<ReturnType<typeof haDiscoveredFlows>>)
  if (!seenLoaded && pushStore) {
    try { for (const id of JSON.parse((await pushStore.getKv(SEEN_KEY)) || '[]')) seenFlows.add(id) } catch { /* fresh */ }
    seenLoaded = true
  }
  const fresh = flows.filter(f => !seenFlows.has(f.flow_id))
  if (!fresh.length) return
  for (const f of fresh) seenFlows.add(f.flow_id)
  if (pushStore) { try { await pushStore.putKv(SEEN_KEY, JSON.stringify([...seenFlows]), 0) } catch { /* best effort */ } }
  // One physical device often shows up under a native handler AND a generic
  // one (a Brother printer → 'brother' + 'ipp'). Collapse those in the nudge.
  const GENERIC_TWINS: Record<string, string[]> = { brother: ['ipp'], hue: ['homekit_controller'], sonos: ['dlna_dmr', 'cast'] }
  const handlers = new Set(fresh.map(f => f.handler))
  for (const [native, twins] of Object.entries(GENERIC_TWINS)) {
    if (handlers.has(native)) for (const t of twins) handlers.delete(t)
  }
  const what = [...handlers].map(nice).join(' and ')
  const first = [...handlers][0] || fresh[0]!.handler
  await notifyOwner(`I spotted something new on the network: ${what}. Want me to set it up? Just ask — e.g. "set up the ${first === 'webostv' ? 'TV' : first}".`)
  log.info('home_discovery_nudge', { handlers: fresh.map(f => f.handler) })
}

/** person entity → last state, for arrival detection. */
const personState = new Map<string, string>()

async function checkArrivals(): Promise<void> {
  if (!pushStore) return
  const people = await haStates(['person']).catch(() => [] as HaEntity[])
  for (const p of people) {
    const prev = personState.get(p.entity_id)
    personState.set(p.entity_id, p.state)
    if (prev === undefined || prev === p.state || p.state !== 'home') continue
    // Someone just arrived — deliver their waiting arrives-home notes.
    try {
      const fam = await import('../family/family.js')
      const { getUsers } = await import('../auth/otp.js')
      const users = await getUsers(pushStore)
      const who = users.filter(u => u.person_entity === p.entity_id)
      for (const u of who) {
        const due = await fam.takePendingNotes(pushStore, u.email, 'home')
        for (const n of due) {
          const from = await fam.memberName(pushStore, n.from)
          const text = `🏠 Welcome home! Note from ${from}: ${n.text}`
          if (!(await fam.notifyUser(pushStore, u.email, text))) await notifyOwner(text)
        }
      }
    } catch (err) { log.warn('arrival_notes_failed', { error: (err as Error).message }) }
  }
}

async function tick(): Promise<void> {
  // Discovery queue changes rarely — check every 5th poll (~5 min default).
  if (discoveryTicks++ % 5 === 0) await checkDiscoveries().catch(() => { /* best effort */ })
  await checkArrivals().catch(() => { /* best effort */ })
  if (pushStore) { import('./briefing.js').then(m => m.maybeSendBriefing(pushStore!, notifyOwner)).catch(() => { /* optional */ }) }
  if (pushStore) { import('../family/family.js').then(m => m.fireDueRoutines(pushStore!, notifyOwner)).catch(() => { /* optional */ }) }
  let entities: HaEntity[]
  try {
    entities = await haStates(['lock', 'binary_sensor', 'cover'])
  } catch (err) {
    log.warn('home_watch_poll_failed', { error: (err as Error).message })
    return
  }
  const now = Date.now()
  const seen = new Set<string>()

  // House mode shifts the posture: away/vacation = instant alerts + motion;
  // guest = stay quiet about doors.
  let effThreshold: number | null = thresholdMs()
  let motion = false
  if (pushStore) {
    try {
      const { getMode, thresholdForMode, motionAlerts } = await import('./mode.js')
      const mode = await getMode(pushStore)
      effThreshold = thresholdForMode(mode, thresholdMs())
      motion = motionAlerts(mode)
    } catch { /* default posture */ }
  }
  if (effThreshold === null) return

  for (const e of entities) {
    const label = watchState(e, motion)
    if (!label) continue
    seen.add(e.entity_id)
    if (!since.has(e.entity_id)) since.set(e.entity_id, now)
    const elapsed = now - (since.get(e.entity_id) || now)
    if (elapsed >= effThreshold && !alerted.has(e.entity_id)) {
      alerted.add(e.entity_id)
      await notifyOwner(phrase(e, label, elapsed / 60_000))
    }
  }

  // Anything no longer in a watch state has resolved — reset its trackers so a
  // future occurrence nudges again.
  for (const id of [...since.keys()]) {
    if (!seen.has(id)) { since.delete(id); alerted.delete(id) }
  }
}

/** Start the proactive loop. Idempotent; no-op unless HA + proactive are on.
 *  Pass the store so nudges can also push to the 0rb apps via FCM. */
export function startHomeWatcher(store?: Store): void {
  // Timers ride the same store + notification channel.
  if (store) { import('./timers.js').then(m => m.startTimerLoop(store, notifyOwner)).catch(() => { /* optional */ }) }
  if (store) pushStore = store
  if (timer || !enabled()) return
  timer = setInterval(() => { void tick() }, intervalMs())
  if (typeof (timer as any).unref === 'function') (timer as any).unref()
  log.info('home_watcher_started', {
    intervalSeconds: intervalMs() / 1000,
    openAlertMinutes: thresholdMs() / 60_000,
  })
  // Fire one pass shortly after boot so we don't wait a full interval.
  setTimeout(() => { void tick() }, 3000).unref?.()
}
