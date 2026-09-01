import { describe, it, expect } from 'bun:test'
import { addIntent, listIntents, updateIntent, removeIntent, fileReport, parseCadence, tickIntents, MAX_ACTIVE } from './engine.js'

const MEMBER = 'martin@example.com'

function freshStore(): any {
  const kv = new Map<string, string>()
  return {
    async getKv(k: string) { return kv.get(k) ?? null },
    async putKv(k: string, v: string) { kv.set(k, v) },
    async delKv(k: string) { kv.delete(k) },
  }
}

describe('intents engine', () => {
  it('parses cadences with a floor', () => {
    expect(parseCadence('daily')).toBe(1440)
    expect(parseCadence('hourly')).toBe(60)
    expect(parseCadence('45m')).toBe(45)
    expect(parseCadence('2h')).toBe(120)
    expect(parseCadence('3d')).toBe(4320)
    expect(parseCadence('5m')).toBe(30)        // floor
    expect(parseCadence(undefined)).toBe(1440) // default daily
    expect(parseCadence(90)).toBe(90)
  })

  it('adds, lists, dedupes and caps', async () => {
    const store = freshStore()
    const r = await addIntent(store, { goal: 'Watch milk price, notify under $4', member: MEMBER, cadence: 'daily' })
    expect(r.ok).toBe(true)
    const dupe = await addIntent(store, { goal: 'watch MILK price, notify under $4', member: MEMBER })
    expect(dupe.ok).toBe(false)
    const short = await addIntent(store, { goal: 'x', member: MEMBER })
    expect(short.ok).toBe(false)
    for (let i = 0; i < MAX_ACTIVE + 2; i++) await addIntent(store, { goal: `distinct goal number ${i} to watch`, member: MEMBER })
    const active = (await listIntents(store)).filter(i => i.status === 'active')
    expect(active.length).toBe(MAX_ACTIVE)
  })

  it('runs due intents, applies reports, routes notify to the journal', async () => {
    const store = freshStore()
    const r = await addIntent(store, { goal: 'Watch the milk price at HEB, usually $4.29, notify under $4', member: MEMBER })
    expect(r.ok).toBe(true)
    const id = (r as any).intent.id
    const ran: string[] = []
    await tickIntents(store, async (s, intent) => {
      ran.push(intent.id)
      await fileReport(s, intent.id, { outcome: 'notify', state: 'baseline $4.29; saw $3.79 today', message: 'Milk is $3.79 at HEB — 50¢ under usual.' })
    })
    expect(ran).toEqual([id])
    const it1 = (await listIntents(store)).find(i => i.id === id)!
    expect(it1.runs).toBe(1)
    expect(it1.last_result).toBe('notify')
    expect(it1.state).toContain('baseline')
    expect(it1.next_at).toBeGreaterThan(Date.now())        // rescheduled
    const { listEvents } = await import('../events/journal.js')
    const evs = await listEvents(store)
    expect(evs.some(e => /Milk is \$3\.79/.test(e.summary))).toBe(true)
    // not due anymore → nothing runs
    const again: string[] = []
    await tickIntents(store, async (_s, i) => { again.push(i.id) })
    expect(again).toEqual([])
  })

  it('treats a silent run as quiet and keeps prior state', async () => {
    const store = freshStore()
    const r = await addIntent(store, { goal: 'Watch something silently for the test', member: MEMBER })
    const id = (r as any).intent.id
    await updateIntent(store, id, { state: 'prior baseline' })
    await tickIntents(store, async () => { /* worker never reports */ })
    const it1 = (await listIntents(store)).find(i => i.id === id)!
    expect(it1.last_result).toBe('no-report')
    expect(it1.state).toBe('prior baseline')
  })

  it('marks done on a done report and expires stale intents', async () => {
    const store = freshStore()
    const r = await addIntent(store, { goal: 'One-shot: notify when the thing ships', member: MEMBER })
    const id = (r as any).intent.id
    await tickIntents(store, async (s, i) => { await fileReport(s, i.id, { outcome: 'done', message: 'It shipped.' }) })
    expect((await listIntents(store)).find(i => i.id === id)!.status).toBe('done')

    const r2 = await addIntent(store, { goal: 'Will expire immediately in this test', member: MEMBER })
    const id2 = (r2 as any).intent.id
    await updateIntent(store, id2, {} as any)
    const all = await listIntents(store)
    all.find(i => i.id === id2)!.expires_at = new Date(Date.now() - 1000).toISOString()
    await store.putKv('intents:all', JSON.stringify(all), 3600)
    await tickIntents(store, async () => { throw new Error('expired intents must not run') })
    expect((await listIntents(store)).find(i => i.id === id2)!.status).toBe('expired')
  })

  it('pause blocks runs; remove deletes', async () => {
    const store = freshStore()
    const r = await addIntent(store, { goal: 'Pausable watch goal for the test', member: MEMBER })
    const id = (r as any).intent.id
    await updateIntent(store, id, { status: 'paused' })
    const ran: string[] = []
    await tickIntents(store, async (_s, i) => { ran.push(i.id) })
    expect(ran).toEqual([])
    expect(await removeIntent(store, id)).toBe(true)
    expect((await listIntents(store)).length).toBe(0)
  })
})
