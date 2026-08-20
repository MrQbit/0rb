/**
 * Narrated first-run (v0.2 S3). After the claim ceremony, the orb walks its
 * new owner through three optional moments — name the orb, say who lives
 * here, look at what was found on the network — as cards in the console,
 * spoken aloud when TTS is up. No wizard walls: every step is skippable,
 * the whole thing is dismissible, and it can be resumed (or re-run) from
 * Settings. Absent state means "done": existing installs never see it —
 * only redeemClaim (fresh systems) or an explicit restart starts it.
 */
import type { Store } from '../store/store.js'

export type FirstRunStep = 'name' | 'members' | 'devices' | 'done'
export interface FirstRunState { step: FirstRunStep; startedAt?: number; completedAt?: number }

const KEY = 'firstrun:state'
const ORDER: FirstRunStep[] = ['name', 'members', 'devices', 'done']

export const NARRATION: Record<Exclude<FirstRunStep, 'done'>, string> = {
  name: "Hello. I'm your orb. What would you like to call me?",
  members: 'Who lives here? Add them now or later — everyone gets their own memory and their own say.',
  devices: "Here's what I can already see on your network. Nothing is connected until you say so.",
}

export async function firstRunState(store: Store): Promise<FirstRunState> {
  try {
    const raw = await store.getKv(KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* treat as done */ }
  return { step: 'done' }
}

export async function startFirstRun(store: Store): Promise<FirstRunState> {
  const s: FirstRunState = { step: 'name', startedAt: Date.now() }
  await store.putKv(KEY, JSON.stringify(s), 0)
  return s
}

export async function advanceFirstRun(store: Store): Promise<FirstRunState> {
  const s = await firstRunState(store)
  const i = ORDER.indexOf(s.step)
  s.step = ORDER[Math.min(i + 1, ORDER.length - 1)]!
  if (s.step === 'done') s.completedAt = Date.now()
  await store.putKv(KEY, JSON.stringify(s), 0)
  return s
}

export async function dismissFirstRun(store: Store): Promise<FirstRunState> {
  const s = await firstRunState(store)
  s.step = 'done'
  s.completedAt = Date.now()
  await store.putKv(KEY, JSON.stringify(s), 0)
  return s
}

/** Everything the console needs to render the current step. */
export async function firstRunView(store: Store): Promise<any> {
  const s = await firstRunState(store)
  if (s.step === 'done') return { active: false }
  const view: any = { active: true, step: s.step, narration: NARRATION[s.step] }
  if (s.step === 'name') {
    view.orbName = process.env.ORB2_ADVERTISE_NAME || 'Orb'
  }
  if (s.step === 'members') {
    const { getUsers } = await import('../auth/otp.js')
    view.members = (await getUsers(store)).map(u => ({ email: u.email, role: u.role }))
  }
  if (s.step === 'devices') {
    view.devices = []
    try {
      const { bridgeEnabled, bridgeDevices } = await import('../connectors/bridge.js')
      if (bridgeEnabled()) {
        const d = await bridgeDevices()
        view.devices.push(
          ...d.speakers.map(x => ({ kind: 'speaker', name: x.name, detail: x.model })),
          ...d.printers.map(x => ({ kind: 'printer', name: x.name, detail: x.location || x.address })),
        )
      }
    } catch { /* bridge optional */ }
    try {
      const { haEnabled, haStates } = await import('../connectors/homeAssistant.js')
      if (haEnabled()) {
        const light = await haStates(['light'])
        const media = await haStates(['media_player'])
        if (light.length) view.devices.push({ kind: 'lights', name: `${light.length} lights`, detail: 'Home Assistant' })
        if (media.length) view.devices.push({ kind: 'media', name: `${media.length} media players`, detail: 'Home Assistant' })
      }
    } catch { /* ha optional */ }
  }
  return view
}
