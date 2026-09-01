import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { classifyTurn, decideTurn, getBrainConfig, setBrainConfig, estimateCents, recordCloudUse, getMonthSpendCents } from './policy.js'

function memStore(): any {
  const kv = new Map<string, string>()
  return {
    async getKv(k: string) { return kv.get(k) ?? null },
    async putKv(k: string, v: string) { kv.set(k, v) },
    async delKv(k: string) { kv.delete(k) },
  }
}

let savedKey: string | undefined
beforeAll(() => { savedKey = process.env.ORB2_ANTHROPIC_KEY; process.env.ORB2_ANTHROPIC_KEY = 'test-key' })
afterAll(() => { if (savedKey !== undefined) process.env.ORB2_ANTHROPIC_KEY = savedKey; else delete process.env.ORB2_ANTHROPIC_KEY })

describe('brain §17', () => {
  it('classifies turns; voice and images never route', () => {
    expect(classifyTurn({ text: 'think hard about this tradeoff', channel: 'chat' })).toBe('deep-chat')
    expect(classifyTurn({ text: 'design the architecture for the new billing system', channel: 'chat' })).toBe('planning')
    expect(classifyTurn({ text: 'x', channel: 'dream' })).toBe('dream')
    expect(classifyTurn({ text: 'x', channel: 'intent' })).toBe('watch-research')
    expect(classifyTurn({ text: 'turn off the lights', channel: 'chat' })).toBeNull()
    expect(classifyTurn({ text: 'think hard', channel: 'voice' })).toBeNull()
    expect(classifyTurn({ text: 'think hard', channel: 'chat', hasImage: true })).toBeNull()
  })

  it('routes nothing until the owner enables it (kill-switch default)', async () => {
    const store = memStore()
    expect(await decideTurn(store, { text: 'think hard about x', channel: 'chat' })).toBeNull()
    await setBrainConfig(store, { enabled: true })
    const d = await decideTurn(store, { text: 'think hard about x', channel: 'chat' })
    expect(d?.class).toBe('deep-chat')
    expect(d?.provider.baseURL).toContain('anthropic')
    // planning is off by default even with master on
    expect(await decideTurn(store, { text: 'design the architecture for a big system', channel: 'chat' })).toBeNull()
    await setBrainConfig(store, { classes: { planning: true } as any })
    expect((await decideTurn(store, { text: 'design the architecture for a big system', channel: 'chat' }))?.class).toBe('planning')
    // kill switch drops everything at once
    await setBrainConfig(store, { enabled: false })
    expect(await decideTurn(store, { text: 'think hard about x', channel: 'chat' })).toBeNull()
  })

  it('over-cap turns fall back to local, and spend accrues', async () => {
    const store = memStore()
    await setBrainConfig(store, { enabled: true, monthly_cap_cents: 1 })
    await recordCloudUse(store, 'deep-chat', 'claude-sonnet-5', 40000, 40000)   // ~ >1c
    expect(await getMonthSpendCents(store)).toBeGreaterThan(1)
    expect(await decideTurn(store, { text: 'think hard about x', channel: 'chat' })).toBeNull()
  })

  it('estimates cost sanely', () => {
    const c = estimateCents(4000, 4000)   // ~1k tokens each way
    expect(c).toBeGreaterThan(1); expect(c).toBeLessThan(3)
  })

  it('config round-trips with defaults', async () => {
    const store = memStore()
    const cfg = await getBrainConfig(store)
    expect(cfg.enabled).toBe(false)
    expect(cfg.classes['deep-chat']).toBe(true)
    expect(cfg.classes.dream).toBe(false)
  })
})
