import { describe, test, expect } from 'bun:test'
import { addRoutine, listRoutines, setRoutineEnabled, removeRoutine, isDue, parseSchedule } from './routines.ts'

function memStore() {
  const kv = new Map<string, string>()
  return {
    async getKv(k: string) { return kv.get(k) ?? null },
    async putKv(k: string, v: string) { kv.set(k, v) },
    async delKv(k: string) { kv.delete(k) },
  } as any
}

describe('routines', () => {
  test('schedule parsing: daily, weekly, interval, garbage', () => {
    expect(parseSchedule('daily at 7:30')).toEqual({ kind: 'daily', at: '07:30' })
    expect(parseSchedule('every morning at 7am')).toEqual({ kind: 'daily', at: '07:00' })
    expect(parseSchedule('every sunday at 5pm')).toEqual({ kind: 'weekly', day: 0, at: '17:00' })
    expect(parseSchedule('every 45 minutes')).toEqual({ kind: 'interval', minutes: 45 })
    expect(parseSchedule('every 2 hours')).toEqual({ kind: 'interval', minutes: 120 })
    expect(parseSchedule('whenever you feel like it')).toBeNull()
  })

  test('due logic: once per scheduled slot; paused never due', () => {
    const r: any = { id: 'rt-1', owner: 'm', instruction: 'x', enabled: true, failures: 0,
      schedule: { kind: 'daily', at: '07:00' } }
    const morning = new Date('2026-08-20T07:05:00')
    expect(isDue(r, morning)).toBe(true)
    r.lastRun = morning.getTime()
    expect(isDue(r, new Date('2026-08-20T08:00:00'))).toBe(false)   // already ran
    expect(isDue({ ...r, lastRun: 0, enabled: false }, morning)).toBe(false)
    const weekly: any = { ...r, lastRun: 0, schedule: { kind: 'weekly', day: 0, at: '17:00' } }
    expect(isDue(weekly, new Date('2026-08-23T17:30:00'))).toBe(true)   // a Sunday
    expect(isDue(weekly, new Date('2026-08-20T17:30:00'))).toBe(false)  // a Thursday
  })

  test('crud + per-member scoping', async () => {
    const s = memStore()
    const r = await addRoutine(s, 'm@x.com', 'plan meals', { kind: 'weekly', day: 0, at: '17:00' })
    await addRoutine(s, 'a@x.com', 'water plants', { kind: 'daily', at: '08:00' })
    expect((await listRoutines(s, 'm@x.com'))).toHaveLength(1)
    expect((await listRoutines(s))).toHaveLength(2)
    expect(await setRoutineEnabled(s, r.id, false)).toBe(true)
    expect((await listRoutines(s, 'm@x.com'))[0]!.enabled).toBe(false)
    expect(await removeRoutine(s, r.id)).toBe(true)
    expect(await removeRoutine(s, r.id)).toBe(false)
  })
})
