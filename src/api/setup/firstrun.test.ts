import { describe, test, expect } from 'bun:test'
import { firstRunState, startFirstRun, advanceFirstRun, dismissFirstRun, firstRunView } from './firstrun.ts'

function memStore() {
  const kv = new Map<string, string>()
  return {
    async getKv(k: string) { return kv.get(k) ?? null },
    async putKv(k: string, v: string) { kv.set(k, v) },
    async delKv(k: string) { kv.delete(k) },
  } as any
}

describe('first-run', () => {
  test('absent state means done — existing installs never see it', async () => {
    const s = memStore()
    expect((await firstRunState(s)).step).toBe('done')
    expect((await firstRunView(s)).active).toBe(false)
  })

  test('walks name → members → devices → done; resumable mid-way', async () => {
    const s = memStore()
    await startFirstRun(s)
    expect((await firstRunView(s)).step).toBe('name')
    expect((await advanceFirstRun(s)).step).toBe('members')
    // "resume" = state persists between loads
    expect((await firstRunView(s)).step).toBe('members')
    expect((await advanceFirstRun(s)).step).toBe('devices')
    const v = await firstRunView(s)
    expect(v.active).toBe(true)
    expect(Array.isArray(v.devices)).toBe(true)
    expect((await advanceFirstRun(s)).step).toBe('done')
    expect((await advanceFirstRun(s)).step).toBe('done') // idempotent at the end
  })

  test('dismiss ends it from any step; restart brings it back', async () => {
    const s = memStore()
    await startFirstRun(s)
    await dismissFirstRun(s)
    expect((await firstRunView(s)).active).toBe(false)
    await startFirstRun(s)
    expect((await firstRunView(s)).step).toBe('name')
  })
})
