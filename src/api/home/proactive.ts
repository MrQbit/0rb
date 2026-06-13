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
import { haEnabled, haStates, type HaEntity } from '../connectors/homeAssistant.js'
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
function watchState(e: HaEntity): string | null {
  if (e.domain === 'lock' && e.state === 'unlocked') return 'unlocked'
  if (e.domain === 'binary_sensor') {
    const cls = e.attributes?.device_class
    if (['door', 'window', 'garage_door', 'opening'].includes(cls) && e.state === 'on') return 'open'
  }
  if (e.domain === 'cover' && e.state === 'open' && e.attributes?.device_class === 'garage') return 'open'
  return null
}

/** A warm, brief, Orb-voice nudge. */
function phrase(e: HaEntity, label: string, mins: number): string {
  const m = Math.round(mins)
  const dur = m >= 60 ? `${Math.round(m / 60)}h` : `${m} min`
  if (label === 'unlocked') return `Heads up — the ${e.name} has been unlocked for ${dur}. Want me to lock it?`
  return `Heads up — the ${e.name} has been open for ${dur}.`
}

async function notifyOwner(text: string): Promise<void> {
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

async function tick(): Promise<void> {
  let entities: HaEntity[]
  try {
    entities = await haStates(['lock', 'binary_sensor', 'cover'])
  } catch (err) {
    log.warn('home_watch_poll_failed', { error: (err as Error).message })
    return
  }
  const now = Date.now()
  const seen = new Set<string>()

  for (const e of entities) {
    const label = watchState(e)
    if (!label) continue
    seen.add(e.entity_id)
    if (!since.has(e.entity_id)) since.set(e.entity_id, now)
    const elapsed = now - (since.get(e.entity_id) || now)
    if (elapsed >= thresholdMs() && !alerted.has(e.entity_id)) {
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
