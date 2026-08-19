import { describe, test, expect, beforeEach } from 'bun:test'
import {
  addNote, listNotes, takePendingNotes, resolveMember, emailFromOwnerId,
  addEvent, listEvents, removeEvent, familyPromptExtra,
} from './family.ts'
import { getUsers, addUser, getRole, isOwner, setRole } from '../auth/otp.ts'

function makeMemStore() {
  const kv = new Map<string, string>()
  return {
    async getKv(k: string) { return kv.get(k) ?? null },
    async putKv(k: string, v: string, _ttl?: number) { kv.set(k, v) },
    async delKv(k: string) { kv.delete(k) },
    _kv: kv,
  } as any
}

let store: any
beforeEach(() => {
  store = makeMemStore()
  process.env.ORB2_AUTH_ALLOWED_EMAILS = 'owner@example.com,kid@example.com'
  delete process.env.ORB2_TELEGRAM_OWNER_ID
})

describe('roles', () => {
  test('first allowlisted user seeds as owner, second as member', async () => {
    expect(await getRole(store, 'owner@example.com')).toBe('owner')
    expect(await getRole(store, 'kid@example.com')).toBe('member')
    expect(await isOwner(store, 'owner@example.com')).toBe(true)
    expect(await isOwner(store, 'kid@example.com')).toBe(false)
  })

  test('unknown emails are members, never owners', async () => {
    expect(await getRole(store, 'stranger@example.com')).toBe('member')
  })

  test('legacy records without a role: first = owner', async () => {
    await getUsers(store) // seed
    const raw = JSON.parse(store._kv.get('auth:users'))
    for (const u of raw) delete u.role
    store._kv.set('auth:users', JSON.stringify(raw))
    expect(await getRole(store, 'owner@example.com')).toBe('owner')
    expect(await getRole(store, 'kid@example.com')).toBe('member')
  })

  test('promote and demote via setRole', async () => {
    await getUsers(store)
    expect((await setRole(store, 'kid@example.com', 'owner')).ok).toBe(true)
    expect(await getRole(store, 'kid@example.com')).toBe('owner')
    expect((await setRole(store, 'kid@example.com', 'member')).ok).toBe(true)
  })

  test('the last owner cannot be demoted', async () => {
    await getUsers(store)
    const r = await setRole(store, 'owner@example.com', 'member')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('last owner')
    expect(await getRole(store, 'owner@example.com')).toBe('owner')
  })

  test('setRole on unknown user fails cleanly', async () => {
    expect((await setRole(store, 'nobody@example.com', 'owner')).ok).toBe(false)
  })
})

describe('family notes', () => {
  test('note delivery marks delivered exactly once', async () => {
    await addNote(store, 'owner@example.com', 'kid@example.com', 'do homework', 'next')
    const due = await takePendingNotes(store, 'kid@example.com', 'next')
    expect(due.length).toBe(1)
    expect(due[0]!.text).toBe('do homework')
    // second take: nothing pending
    expect((await takePendingNotes(store, 'kid@example.com', 'next')).length).toBe(0)
    // still on the board, marked delivered
    const all = await listNotes(store)
    expect(all.length).toBe(1)
    expect(all[0]!.delivered).toBeTruthy()
  })

  test('home-trigger notes do not deliver on next-chat trigger', async () => {
    await addNote(store, 'owner@example.com', 'kid@example.com', 'trash out', 'home')
    expect((await takePendingNotes(store, 'kid@example.com', 'next')).length).toBe(0)
    expect((await takePendingNotes(store, 'kid@example.com', 'home')).length).toBe(1)
  })

  test('notes only reach their recipient', async () => {
    await addNote(store, 'owner@example.com', 'kid@example.com', 'secret', 'next')
    expect((await takePendingNotes(store, 'owner@example.com', 'next')).length).toBe(0)
  })

  test('familyPromptExtra names the user, role, and pending notes', async () => {
    await addNote(store, 'owner@example.com', 'kid@example.com', 'call grandma', 'next')
    const extra = await familyPromptExtra(store, 'user:kid@example.com')
    expect(extra).toContain('kid@example.com')
    expect(extra).toContain('member')
    expect(extra).toContain('call grandma')
    // notes were consumed by the prompt build
    expect((await takePendingNotes(store, 'kid@example.com', 'next')).length).toBe(0)
  })

  test('familyPromptExtra is empty for unknown identities', async () => {
    expect(await familyPromptExtra(store, 'whatsapp:+15550001')).toBe('')
    expect(await familyPromptExtra(store, '')).toBe('')
  })
})

describe('member resolution', () => {
  test('resolves by email, local part, and label', async () => {
    await addUser(store, { email: 'sarah@example.com', label: 'Sarah' })
    expect((await resolveMember(store, 'sarah@example.com'))?.email).toBe('sarah@example.com')
    expect((await resolveMember(store, 'sarah'))?.email).toBe('sarah@example.com')
    expect((await resolveMember(store, 'Sarah'))?.email).toBe('sarah@example.com')
    expect(await resolveMember(store, 'nobody')).toBeNull()
  })

  test('emailFromOwnerId strips the identity prefix', () => {
    expect(emailFromOwnerId('user:A@B.co')).toBe('a@b.co')
    expect(emailFromOwnerId('owner')).toBe('owner')
  })
})

describe('family calendar', () => {
  test('add validates date and time formats', async () => {
    expect('error' in (await addEvent(store, { title: 'x', date: 'tomorrow' }))).toBe(true)
    expect('error' in (await addEvent(store, { title: 'x', date: '2030-01-02', time: 'noonish' }))).toBe(true)
    expect('error' in (await addEvent(store, { title: 'x', date: '2030-01-02', time: '9:30' }))).toBe(false)
  })

  test('events sort by date+time and past events age out', async () => {
    await addEvent(store, { title: 'later', date: '2031-05-02' })
    await addEvent(store, { title: 'sooner', date: '2031-05-01', time: '18:00' })
    await addEvent(store, { title: 'morning', date: '2031-05-01', time: '09:00' })
    const ev = await listEvents(store)
    expect(ev.map(e => e.title)).toEqual(['morning', 'sooner', 'later'])
  })

  test('removeEvent matches by title substring', async () => {
    await addEvent(store, { title: 'Dentist for kid', date: '2031-06-01' })
    const gone = await removeEvent(store, 'dentist')
    expect(gone?.title).toBe('Dentist for kid')
    expect((await listEvents(store)).length).toBe(0)
  })
})

describe('critical settings gate (round 2)', () => {
  test('CRITICAL_SETTINGS covers brain, auth, channels, HA credentials', async () => {
    const { CRITICAL_SETTINGS, SETTINGS_KEYS } = await import('../settingsKeys.ts')
    for (const k of ['OPENAI_MODEL', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'ORB2_AUTH_ALLOWED_EMAILS', 'ORB2_HA_TOKEN', 'ORB2_TELEGRAM_BOT_TOKEN']) {
      expect(CRITICAL_SETTINGS.has(k)).toBe(true)
    }
    // every critical key is a real settings key (no typo drift)
    for (const k of CRITICAL_SETTINGS) expect((SETTINGS_KEYS as readonly string[]).includes(k)).toBe(true)
    // benign keys stay member-changeable
    expect(CRITICAL_SETTINGS.has('ORB2_TTS_VOICE')).toBe(false)
    expect(CRITICAL_SETTINGS.has('ORB2_HOME_LOCATION')).toBe(false)
  })
})

describe('per-person preferences', () => {
  test('set, list, overwrite, delete — isolated per member', async () => {
    const { getPrefs, setPref } = await import('./family.ts')
    await setPref(store, 'kid@example.com', 'nickname', 'Max')
    await setPref(store, 'kid@example.com', 'style', 'short answers')
    await setPref(store, 'owner@example.com', 'coffee', 'flat white')
    expect(await getPrefs(store, 'kid@example.com')).toEqual({ nickname: 'Max', style: 'short answers' })
    expect(await getPrefs(store, 'owner@example.com')).toEqual({ coffee: 'flat white' })
    await setPref(store, 'kid@example.com', 'nickname', '')
    expect((await getPrefs(store, 'kid@example.com')).nickname).toBeUndefined()
  })

  test('prefs surface in the member prompt only', async () => {
    const { setPref } = await import('./family.ts')
    await setPref(store, 'kid@example.com', 'nickname', 'Max')
    const kidExtra = await familyPromptExtra(store, 'user:kid@example.com')
    expect(kidExtra).toContain('nickname: Max')
    const ownerExtra = await familyPromptExtra(store, 'user:owner@example.com')
    expect(ownerExtra).not.toContain('nickname: Max')
  })
})

describe('chores', () => {
  test('add, complete, one-off cleanup', async () => {
    const { addChore, listChores, completeChore } = await import('./family.ts')
    await addChore(store, 'Take out trash', 'kid@example.com')
    await addChore(store, 'Water plants', 'owner@example.com', 3)
    let chores = await listChores(store)
    expect(chores.length).toBe(2)
    const done = await completeChore(store, 'trash')
    expect(done?.title).toBe('Take out trash')
    expect((await completeChore(store, 'trash'))).toBeNull() // already done
    chores = await listChores(store)
    expect(chores.find(c => c.title === 'Water plants')?.done).toBeUndefined()
  })
})

describe('recurring shopping staples (loop A2)', () => {
  test('sweepRecurring revives staples after their cycle, leaves the rest', async () => {
    const { sweepRecurring } = await import('../shopping/routes.ts')
    const now = Date.now()
    const items: any[] = [
      { id: '1', name: 'milk', done: true, added: 0, recur_days: 7, done_at: now - 8 * 86_400_000 },
      { id: '2', name: 'eggs', done: true, added: 0, recur_days: 7, done_at: now - 2 * 86_400_000 },
      { id: '3', name: 'oneoff', done: true, added: 0, done_at: now - 30 * 86_400_000 },
      { id: '4', name: 'open', done: false, added: 0, recur_days: 7 },
    ]
    const revived = sweepRecurring(items, now)
    expect(revived.map(r => r.name)).toEqual(['milk'])
    expect(items.find(i => i.name === 'milk')!.done).toBe(false)
    expect(items.find(i => i.name === 'eggs')!.done).toBe(true)
    expect(items.find(i => i.name === 'oneoff')!.done).toBe(true)
  })
})

describe('house modes (loop A3)', () => {
  test('thresholds per mode: away/vacation instant, guest muted, home base', async () => {
    const { thresholdForMode, motionAlerts } = await import('../home/mode.ts')
    expect(thresholdForMode('home', 600000)).toBe(600000)
    expect(thresholdForMode('away', 600000)).toBe(0)
    expect(thresholdForMode('vacation', 600000)).toBe(0)
    expect(thresholdForMode('guest', 600000)).toBeNull()
    expect(motionAlerts('away')).toBe(true)
    expect(motionAlerts('home')).toBe(false)
    expect(motionAlerts('guest')).toBe(false)
  })

  test('mode store roundtrip + garbage defaults to home', async () => {
    const { getMode, setMode } = await import('../home/mode.ts')
    expect(await getMode(store)).toBe('home')
    await setMode(store, 'away')
    expect(await getMode(store)).toBe('away')
    store._kv.set('home:mode', 'party')
    expect(await getMode(store)).toBe('home')
  })
})

describe('care routines (loop A4)', () => {
  test('dueRoutines: time gating, weekday filter, once per day', async () => {
    const { dueRoutines } = await import('./family.ts')
    const now = new Date('2031-03-03T08:30:00') // a Monday
    const today = now.toISOString().slice(0, 10)
    const rs: any[] = [
      { id: '1', label: 'meds', at: '08:00', to: 'a@x.co' },                      // due (time passed)
      { id: '2', label: 'evening pills', at: '20:00', to: 'a@x.co' },             // not yet
      { id: '3', label: 'water plants', at: '08:00', days: [0], to: 'a@x.co' },   // Sunday only
      { id: '4', label: 'feed cat', at: '07:00', to: 'a@x.co', last_fired: today }, // already fired
      { id: '5', label: 'mon-only', at: '06:00', days: [1], to: 'a@x.co' },       // due (Monday)
    ]
    expect(dueRoutines(rs, now).map(r => r.label)).toEqual(['meds', 'mon-only'])
  })

  test('addRoutine validates time and days', async () => {
    const { addRoutine } = await import('./family.ts')
    expect('error' in (await addRoutine(store, { label: 'x', at: 'morning', to: 'a@x.co' }))).toBe(true)
    expect('error' in (await addRoutine(store, { label: 'x', at: '08:00', days: [9], to: 'a@x.co' }))).toBe(true)
    expect('error' in (await addRoutine(store, { label: 'x', at: '08:00', to: 'a@x.co' }))).toBe(false)
  })
})

describe('safety-class alerts (loop A8)', () => {
  test('smoke/CO/gas/moisture trigger; doors and off-states do not', async () => {
    const { safetyState } = await import('../home/proactive.ts')
    const mk = (device_class: string, state: string) =>
      ({ entity_id: 'binary_sensor.x', domain: 'binary_sensor', name: 'x', state, attributes: { device_class } }) as any
    expect(safetyState(mk('smoke', 'on'))).toContain('SMOKE')
    expect(safetyState(mk('carbon_monoxide', 'on'))).toContain('CARBON')
    expect(safetyState(mk('gas', 'on'))).toContain('GAS')
    expect(safetyState(mk('moisture', 'on'))).toContain('LEAK')
    expect(safetyState(mk('smoke', 'off'))).toBeNull()
    expect(safetyState(mk('door', 'on'))).toBeNull()
    expect(safetyState({ entity_id: 'lock.a', domain: 'lock', name: 'a', state: 'unlocked', attributes: {} } as any)).toBeNull()
  })
})

describe('device health watch (loop A9)', () => {
  test('flags low batteries and long-unavailable; ignores healthy', async () => {
    const { healthIssues } = await import('../home/proactive.ts')
    const now = Date.now()
    const mk = (over: any) => ({ entity_id: 'x.'+Math.random(), domain: 'sensor', name: over.name || 'dev', state: '50', attributes: {}, ...over })
    const issues = healthIssues([
      mk({ name: 'Door sensor battery', attributes: { device_class: 'battery' }, state: '9' }),
      mk({ name: 'Healthy battery', attributes: { device_class: 'battery' }, state: '80' }),
      mk({ name: 'Zero-reading battery', attributes: { device_class: 'battery' }, state: '0' }), // 0 = often "unknown", skip
      mk({ name: 'Ghost cam', domain: 'camera', state: 'unavailable', attributes: { orb_last_changed: now - 48 * 3600_000 } }),
      mk({ name: 'Blip', domain: 'light', state: 'unavailable', attributes: { orb_last_changed: now - 3600_000 } }),
    ] as any, now)
    expect(issues.map(i => i.name).sort()).toEqual(['Door sensor battery', 'Ghost cam'])
    expect(issues.find(i => i.name === 'Door sensor battery')!.detail).toBe('9%')
  })
})

describe('smart-paste key detection (connectors QoL)', () => {
  test('unambiguous shapes map to one service', async () => {
    const { detectKey } = await import('../connectors/keyDetect.ts')
    const one = (p: string) => { const m = detectKey(p); expect(m.length).toBe(1); expect(m[0]!.certain).toBe(true); return m[0]! }
    expect(one('AIzaSyB-abc123def456ghi789jkl012mno345p').setting).toBe('ORB2_YOUTUBE_API_KEY')
    expect(one('sk-or-v1-' + 'a'.repeat(48)).setting).toBe('ORB2_OPENROUTER_KEY')
    expect(one('sk-ant-api03-xyz').setting).toBe('OPENAI_API_KEY')
    expect(one('sk-proj-' + 'A'.repeat(30)).setting).toBe('OPENAI_API_KEY')
    expect(one('BSA' + 'x'.repeat(24)).setting).toBe('ORB2_BRAVE_API_KEY')
    const jwt = 'eyJ' + 'a'.repeat(40) + '.' + 'b'.repeat(50) + '.' + 'c'.repeat(40)
    expect(one(jwt).setting).toBe('ORB2_HA_TOKEN')
  })

  test('32-hex is ambiguous: spotify id/secret or newsapi', async () => {
    const { detectKey } = await import('../connectors/keyDetect.ts')
    const m = detectKey('a'.repeat(32))
    expect(m.length).toBe(3)
    expect(m.every(x => !x.certain)).toBe(true)
  })

  test('garbage and multi-word strings are rejected', async () => {
    const { detectKey } = await import('../connectors/keyDetect.ts')
    expect(detectKey('hello world').length).toBe(0)
    expect(detectKey('short').length).toBe(0)
    expect(detectKey('').length).toBe(0)
  })
})
