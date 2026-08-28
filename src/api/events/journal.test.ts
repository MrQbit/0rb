import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { logEvent, listEvents, digest, getNotifPrefs, setNotifPrefs } from './journal.ts'

let saved: string | undefined
beforeAll(() => { saved = process.env.ORB2_AUTH_ALLOWED_EMAILS; delete process.env.ORB2_AUTH_ALLOWED_EMAILS })
afterAll(() => { if (saved !== undefined) process.env.ORB2_AUTH_ALLOWED_EMAILS = saved })

function memStore() {
  const kv = new Map<string, string>()
  return {
    async getKv(k: string) { return kv.get(k) ?? null },
    async putKv(k: string, v: string) { kv.set(k, v) },
    async delKv(k: string) { kv.delete(k) },
  } as any
}

describe('event journal (SPEC §4)', () => {
  test('append, since-filter, cap', async () => {
    const s = memStore()
    const a = await logEvent(s, { kind: 'mode', summary: 'House mode → away', attention: 'glance' })
    await new Promise(r => setTimeout(r, 3))
    await logEvent(s, { kind: 'delivery', summary: 'Package delivered', attention: 'notify' })
    expect((await listEvents(s))).toHaveLength(2)
    expect((await listEvents(s, { since: a.t }))).toHaveLength(1)
  })

  test('spoiler guard: gift events invisible to the recipient', async () => {
    const s = memStore()
    await logEvent(s, { kind: 'order', summary: 'Gift ordered', attention: 'glance', giftFor: 'ana@x.com' })
    expect((await listEvents(s, { member: 'ana@x.com' }))).toHaveLength(0)
    expect((await listEvents(s, { member: 'owner@x.com' }))).toHaveLength(1)
  })

  test('digest groups and summarizes', async () => {
    const s = memStore()
    await logEvent(s, { kind: 'arrival', member: 'a@x.com', summary: 'a arrived', attention: 'glance' })
    await logEvent(s, { kind: 'delivery', summary: 'filament delivered', attention: 'notify' })
    await logEvent(s, { kind: 'receipt', summary: 'Locked the door', attention: 'glance' })
    const d = digest(await listEvents(s))
    expect(d.line).toContain('While you were out')
    expect(Object.keys(d.groups)).toContain('people')
    expect(Object.keys(d.groups)).toContain('orders & deliveries')
  })

  test('notif prefs default + persist', async () => {
    const s = memStore()
    expect((await getNotifPrefs(s, 'a@x.com')).pushMin).toBe('notify')
    await setNotifPrefs(s, 'a@x.com', { pushMin: 'interrupt' })
    expect((await getNotifPrefs(s, 'a@x.com')).pushMin).toBe('interrupt')
  })
})
