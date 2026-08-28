import { describe, test, expect } from 'bun:test'
import { logEpisode, recentEpisodes } from './episodes.ts'

function memStore() {
  const kv = new Map<string, string>()
  return {
    async getKv(k: string) { return kv.get(k) ?? null },
    async putKv(k: string, v: string) { kv.set(k, v) },
    async delKv(k: string) { kv.delete(k) },
  } as any
}

describe('episodic memory', () => {
  test('logs, caps, and replays in order; dream turns are excluded', async () => {
    const s = memStore()
    await logEpisode(s, { who: 'user:a@x.com', text: 'I moved my piano lesson to Thursdays', reply: 'Noted.', session: 'web-1' })
    await logEpisode(s, { who: 'dream', text: 'consolidate', reply: 'done', session: 'dream:1' })
    await logEpisode(s, { who: 'user:a@x.com', text: '', reply: 'x', session: 'web-1' })
    const eps = await recentEpisodes(s)
    expect(eps).toHaveLength(1)
    expect(eps[0]!.who).toBe('a@x.com')
    expect(eps[0]!.text).toContain('piano lesson')
    for (let i = 0; i < 230; i++) await logEpisode(s, { who: 'u', text: `msg ${i}`, reply: 'r', session: 's' })
    const capped = await recentEpisodes(s, 1, 500)
    expect(capped.length).toBeLessThanOrEqual(200)
    expect(capped[capped.length - 1]!.text).toBe('msg 229')
  })
})
