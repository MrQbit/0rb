import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { tryFastPath } from './fastpath.ts'

function memStore() {
  const kv = new Map<string, string>()
  return {
    async getKv(k: string) { return kv.get(k) ?? null },
    async putKv(k: string, v: string) { kv.set(k, v) },
    async delKv(k: string) { kv.delete(k) },
  } as any
}

// HA is mocked at the fetch layer: states list + service calls.
const REAL_FETCH = globalThis.fetch
const HA_STATES = [
  { entity_id: 'light.kitchen', state: 'on', attributes: { friendly_name: 'Kitchen lights', brightness: 204 } },
  { entity_id: 'light.desk', state: 'off', attributes: { friendly_name: 'Desk lamp' } },
  { entity_id: 'light.lamp_a', state: 'off', attributes: { friendly_name: 'Reading lamp' } },
  { entity_id: 'light.lamp_b', state: 'off', attributes: { friendly_name: 'Reading lamp' } },
  { entity_id: 'media_player.living', state: 'playing', attributes: { friendly_name: 'Living Room' } },
  { entity_id: 'lock.front', state: 'locked', attributes: { friendly_name: 'Front door' } },
  { entity_id: 'cover.bedroom', state: 'open', attributes: { friendly_name: 'Bedroom shades' } },
]
let serviceCalls: string[] = []

beforeEach(() => {
  serviceCalls = []
  process.env.ORB2_HA_URL = 'http://ha.test'
  process.env.ORB2_HA_TOKEN = 'tok'
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url)
    if (u.includes('/api/states')) return new Response(JSON.stringify(HA_STATES), { status: 200, headers: { 'content-type': 'application/json' } })
    if (u.includes('/api/services/')) { serviceCalls.push(`${u.split('/api/services/')[1]} ${init?.body || ''}`); return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }) }
    if (u.includes('/api/websocket') || u.includes('registry')) return new Response('[]', { status: 200 })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as any
})
afterEach(() => { globalThis.fetch = REAL_FETCH })
afterAll(() => { globalThis.fetch = REAL_FETCH })

describe('fast-path: device control', () => {
  test.each([
    ['turn off the kitchen lights', 'light/turn_off', 'Kitchen lights off.'],
    ['turn on the desk lamp', 'light/turn_on', 'Desk lamp on.'],
    ['hey orb, turn on the desk lamp', 'light/turn_on', 'Desk lamp on.'],
    ['turn the desk lamp off', 'light/turn_off', 'Desk lamp off.'],
    ['open the bedroom shades', 'cover/open_cover', 'Bedroom shades open.'],
    ['close the bedroom shades', 'cover/close_cover', 'Bedroom shades close.'],
  ])('%s', async (utterance, service, reply) => {
    const store = memStore()
    const r = await tryFastPath(store, 'martin', utterance)
    expect(r).toBe(reply)
    expect(serviceCalls.join(' ')).toContain(service)
  })

  test('dim to percent', async () => {
    const r = await tryFastPath(memStore(), 'martin', 'dim the kitchen lights to 30')
    expect(r).toBe('Set Kitchen lights to 30%.')
    expect(serviceCalls.join(' ')).toContain('brightness_pct')
  })

  test('volume set routes to the media player', async () => {
    const r = await tryFastPath(memStore(), 'martin', 'set the volume on the living room to 25')
    expect(r).toContain('Living Room to 25')
    expect(serviceCalls.join(' ')).toContain('volume_set')
  })

  test('ambiguous names fall through to the model', async () => {
    expect(await tryFastPath(memStore(), 'martin', 'turn on the reading lamp')).toBeNull()
    expect(serviceCalls).toHaveLength(0)
  })

  test('locks NEVER match the fast-path', async () => {
    expect(await tryFastPath(memStore(), 'martin', 'turn off the front door')).toBeNull()
    expect(await tryFastPath(memStore(), 'martin', 'open the front door')).toBeNull()
    expect(serviceCalls).toHaveLength(0)
  })

  test('unknown devices fall through', async () => {
    expect(await tryFastPath(memStore(), 'martin', 'turn on the disco ball')).toBeNull()
  })
})

describe('fast-path: timers', () => {
  test('set with digits and words, cancel unique', async () => {
    const store = memStore()
    expect(await tryFastPath(store, 'martin', 'set a timer for 9 minutes')).toBe('Timer set — 9 minutes.')
    expect(await tryFastPath(store, 'martin', 'set a pasta timer for ten minutes')).toBe('Pasta timer set — 10 minutes.')
    expect(await tryFastPath(store, 'martin', 'cancel the pasta timer')).toBe('Pasta timer cancelled.')
    // two timers left ambiguity: only 'timer' remains → unique → cancels
    expect(await tryFastPath(store, 'martin', 'cancel the timer')).toBe('Timer timer cancelled.')
  })
  test('nonsense duration falls through', async () => {
    expect(await tryFastPath(memStore(), 'martin', 'set a timer for eleventy minutes')).toBeNull()
  })
})

describe('fast-path: mode, undo, time', () => {
  test('house mode with receipt inverse; same mode is a no-op reply', async () => {
    const store = memStore()
    expect(await tryFastPath(store, 'martin', "we're leaving")).toBe('House mode: away.')
    expect(await tryFastPath(store, 'martin', 'set the house to away')).toBe('The house is already set to away.')
    const { listReceipts } = await import('../policy/policy.ts')
    const receipts = await listReceipts(store, 5)
    expect(receipts[0]!.summary).toContain('away')
    expect(receipts[0]!.inverse).toEqual({ kind: 'mode', mode: 'home' })
  })

  test('undo that reverses the last undoable action', async () => {
    const store = memStore()
    await tryFastPath(store, 'martin', 'turn off the kitchen lights')
    const r = await tryFastPath(store, 'martin', 'undo that')
    expect(r).toContain('Undid')
    expect(serviceCalls.join(' ')).toContain('turn_on')     // restore prior on@80%
  })

  test('time and date answer instantly', async () => {
    expect(await tryFastPath(memStore(), 'martin', 'what time is it')).toMatch(/It's \d/)
    expect(await tryFastPath(memStore(), 'martin', 'what day is it')).toMatch(/It's /)
  })

  test('chatty sentences fall through to the model', async () => {
    expect(await tryFastPath(memStore(), 'martin', 'what do you think about turning the lights off when nobody is home')).toBeNull()
    expect(await tryFastPath(memStore(), 'martin', 'tell me a story about a lamp')).toBeNull()
  })
})
