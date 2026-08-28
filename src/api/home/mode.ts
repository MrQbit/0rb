/**
 * House modes — one word that changes how the house behaves.
 *
 *   home      normal life; gentle nudges (door open 10 min)
 *   away      nobody in: IMMEDIATE alerts on any door/window/motion,
 *             leaving macro offered (lock up, lights off)
 *   vacation  away, plus daily status in the owner's channel
 *   guest     visitors: proactive nudges muted (no "door open" nagging)
 *
 * The proactive watcher consults the mode for thresholds; the agent flips
 * modes ("we're leaving", "back home") via the Home tool.
 */
import type { Store } from '../store/store.js'

export type HouseMode = 'home' | 'away' | 'vacation' | 'guest'
const KEY = 'home:mode'

export async function getMode(store: Store): Promise<HouseMode> {
  const raw = (await store.getKv(KEY).catch(() => null)) || 'home'
  return (['home', 'away', 'vacation', 'guest'] as const).includes(raw as HouseMode) ? (raw as HouseMode) : 'home'
}

export async function setMode(store: Store, mode: HouseMode): Promise<void> {
  void import('../events/journal.js').then(({ logEvent }) => logEvent(store, {
    kind: 'mode', summary: `House mode → ${mode}`, attention: 'glance',
  })).catch(() => {})
  await store.putKv(KEY, mode, 0)
}

/**
 * Alert threshold (ms a door/lock may stay open before a nudge) per mode.
 * Pure — unit tested. baseMs is the configured normal threshold.
 */
export function thresholdForMode(mode: HouseMode, baseMs: number): number | null {
  switch (mode) {
    case 'away':
    case 'vacation':
      return 0            // nobody should be opening anything — alert now
    case 'guest':
      return null         // visitors roam; don't nag
    default:
      return baseMs
  }
}

/** Whether motion sensors should alert in this mode (only when empty). */
export function motionAlerts(mode: HouseMode): boolean {
  return mode === 'away' || mode === 'vacation'
}
