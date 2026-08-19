/**
 * Orb-native presence — the phones report home/away directly (geofence in
 * the apps), no Home Assistant device_tracker required. This is what makes
 * "who's home" real: it feeds the presence widget, the Matter occupancy
 * sensors Apple Home shows, and the arrival routines (auto-disarm, arrival
 * scene, welcome-home notes).
 *
 * HA person entities still merge in (some homes track presence there);
 * a fresh phone report wins over a stale HA state.
 */
import type { Store } from '../store/store.js'
import { log } from '../log.js'

const KEY = 'presence:people'
const FRESH_MS = 6 * 60 * 60 * 1000   // phone reports older than 6h stop overriding

export interface PresenceEntry {
  email: string
  name: string
  home: boolean
  at: number          // epoch ms of the last report
  source: string      // 'geofence' | 'manual' | …
}

async function load(store: Store): Promise<Record<string, PresenceEntry>> {
  try { return JSON.parse((await store.getKv(KEY)) || '{}') } catch { return {} }
}

/** A phone reported crossing the home boundary. Returns whether this was an
 *  arrival flip (so the caller can say so). */
export async function reportPresence(store: Store, email: string, home: boolean, source = 'geofence'): Promise<{ changed: boolean; arrived: boolean }> {
  const all = await load(store)
  const prev = all[email]
  const name = await displayName(store, email)
  all[email] = { email, name, home, at: Date.now(), source }
  await store.putKv(KEY, JSON.stringify(all), 0)
  const changed = !prev || prev.home !== home
  const arrived = changed && home && prev !== undefined
  log.info('presence_report', { email, home, source, changed })
  if (arrived) {
    const { handleArrivalForUser } = await import('../home/proactive.js')
    handleArrivalForUser(store, email, name).catch(() => { /* best effort */ })
  }
  return { changed, arrived }
}

/** Merged household presence: phone reports first, HA persons fill gaps. */
export async function listPresence(store: Store): Promise<Array<{ name: string; home: boolean; source: string }>> {
  const out = new Map<string, { name: string; home: boolean; source: string }>()
  const native = await load(store)
  for (const e of Object.values(native)) {
    if (Date.now() - e.at < FRESH_MS) out.set(e.name.toLowerCase(), { name: e.name, home: e.home, source: e.source })
  }
  try {
    const { haStates } = await import('../connectors/homeAssistant.js')
    for (const p of await haStates(['person'])) {
      const k = p.name.toLowerCase()
      if (!out.has(k) && (p.state === 'home' || p.state === 'not_home')) {
        out.set(k, { name: p.name, home: p.state === 'home', source: 'home-assistant' })
      }
    }
  } catch { /* HA optional */ }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

async function displayName(store: Store, email: string): Promise<string> {
  try {
    const { getUsers } = await import('../auth/otp.js')
    const u = (await getUsers(store)).find(x => x.email === email)
    if (u?.label) return u.label
  } catch { /* fall through */ }
  const stem = email.split('@')[0] || email
  return stem.charAt(0).toUpperCase() + stem.slice(1)
}
