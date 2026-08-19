import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { cosine, foldCentroid, getProfile, observeUtterance, speakerContextLine, ENROLL_MIN, type SpeakerCheck } from './speakerid.ts'

function makeMemStore() {
  const kv = new Map<string, string>()
  return {
    async getKv(k: string) { return kv.get(k) ?? null },
    async putKv(k: string, v: string, _ttl?: number) { kv.set(k, v) },
    async delKv(k: string) { kv.delete(k) },
    _kv: kv,
  } as any
}

// Deterministic fake voices: near-orthogonal unit-ish vectors with noise.
function voice(base: number[], noise = 0.05, seedShift = 0): number[] {
  return base.map((v, i) => v + noise * Math.sin(i * 7.13 + seedShift * 3.7))
}
const DIM = 32
const ALICE = Array.from({ length: DIM }, (_, i) => (i % 3 === 0 ? 1 : 0.1))
const BOB = Array.from({ length: DIM }, (_, i) => (i % 3 === 1 ? 1 : 0.1))

let store: any
beforeEach(() => {
  store = makeMemStore()
  process.env.ORB2_AUTH_ALLOWED_EMAILS = 'alice@example.com,bob@example.com'
  // Point at nothing — tests inject embeddings by monkeypatching fetch.
  process.env.ORB2_STT_URL = 'http://stt.test'
})

// Restore the real fetch after this file — later suites do real network calls.
const REAL_FETCH = globalThis.fetch
afterAll(() => { globalThis.fetch = REAL_FETCH })

function mockEmbed(vec: number[]) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ embedding: vec, dim: vec.length }), { status: 200 })) as any
}

describe('vector math', () => {
  test('cosine: identical=1, orthogonal≈0, degenerate=0', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0)
    expect(cosine([0, 0], [1, 1])).toBe(0)
  })

  test('foldCentroid converges toward repeated samples', () => {
    let p = foldCentroid(null, voice(ALICE, 0.2, 1))
    for (let i = 0; i < 10; i++) p = foldCentroid(p, voice(ALICE, 0.2, i))
    expect(p.n).toBe(11)
    expect(cosine(p.centroid, ALICE)).toBeGreaterThan(0.95)
  })
})

describe('enrollment and matching', () => {
  async function enroll(email: string, base: number[], count: number) {
    for (let i = 0; i < count; i++) {
      mockEmbed(voice(base, 0.05, i))
      await observeUtterance(store, email, new Uint8Array(16000))
    }
  }

  test('self-enrolls the session user up to a trusted profile', async () => {
    await enroll('alice@example.com', ALICE, ENROLL_MIN)
    const p = await getProfile(store, 'alice@example.com')
    expect(p?.n).toBe(ENROLL_MIN)
    expect(cosine(p!.centroid, ALICE)).toBeGreaterThan(0.95)
  })

  test("alice's voice on alice's session: no mismatch", async () => {
    await enroll('alice@example.com', ALICE, ENROLL_MIN)
    mockEmbed(voice(ALICE, 0.05, 99))
    const check = await observeUtterance(store, 'alice@example.com', new Uint8Array(16000))
    expect(check.mismatch).toBe(false)
    expect(check.match?.email).toBe('alice@example.com')
  })

  test("bob's voice on alice's session: mismatch flagged, alice's profile not polluted", async () => {
    await enroll('alice@example.com', ALICE, ENROLL_MIN)
    await enroll('bob@example.com', BOB, ENROLL_MIN)
    const aliceBefore = await getProfile(store, 'alice@example.com')
    mockEmbed(voice(BOB, 0.05, 42))
    const check = await observeUtterance(store, 'alice@example.com', new Uint8Array(16000))
    expect(check.mismatch).toBe(true)
    expect(check.match?.email).toBe('bob@example.com')
    expect(check.enrolled).toBe(false)
    const aliceAfter = await getProfile(store, 'alice@example.com')
    expect(aliceAfter?.n).toBe(aliceBefore?.n)
  })

  test('embedding failure degrades silently', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 500 })) as any
    const check = await observeUtterance(store, 'alice@example.com', new Uint8Array(16000))
    expect(check).toEqual({ mismatch: false, enrolled: false })
  })

  test('non-email identities are ignored', async () => {
    mockEmbed(voice(ALICE))
    const check = await observeUtterance(store, 'whatsapp:+15550001', new Uint8Array(16000))
    expect(check.enrolled).toBe(false)
  })
})

describe('prompt line', () => {
  test('silent when no mismatch; explicit when someone else talks', () => {
    const quiet: SpeakerCheck = { mismatch: false, enrolled: true }
    expect(speakerContextLine(quiet, 'alice@example.com')).toBe('')
    const loud: SpeakerCheck = { mismatch: true, enrolled: false, match: { email: 'bob@example.com', similarity: 0.83 } }
    const line = speakerContextLine(loud, 'alice@example.com')
    expect(line).toContain('bob')
    expect(line).toContain('83%')
    expect(line).toContain('alice')
  })
})
