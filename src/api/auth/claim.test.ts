import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { claimAvailable, currentClaim, redeemClaim } from './claim.ts'

// A claim window only exists on a truly blank install — an env-provisioned
// allowlist counts as "already owned", so blank it out for these tests.
let savedAllow: string | undefined
beforeAll(() => { savedAllow = process.env.ORB2_AUTH_ALLOWED_EMAILS; delete process.env.ORB2_AUTH_ALLOWED_EMAILS })
afterAll(() => { if (savedAllow !== undefined) process.env.ORB2_AUTH_ALLOWED_EMAILS = savedAllow })

function memStore() {
  const kv = new Map<string, string>()
  return {
    async getKv(k: string) { return kv.get(k) ?? null },
    async putKv(k: string, v: string) { kv.set(k, v) },
    async delKv(k: string) { kv.delete(k) },
  } as any
}

describe('claim ceremony', () => {
  test('unowned orb offers a code; owned orb refuses', async () => {
    const s = memStore()
    process.env.ORB2_SESSION_SECRET ||= 'test-secret'
    expect(await claimAvailable(s)).toBe(true)
    const c = await currentClaim(s, 'orb.local')
    expect(c!.uri).toStartWith('orb2-claim://orb.local/')
    expect(c!.code).toHaveLength(8)
    // stable until expiry
    expect((await currentClaim(s, 'orb.local'))!.code).toBe(c!.code)
  })

  test('redeem: wrong code fails, right code mints THE owner once', async () => {
    const s = memStore()
    const c = await currentClaim(s, 'orb.local')
    expect((await redeemClaim(s, 'NOPE1234', 'a@x.com')).error).toBe('wrong code')
    const r = await redeemClaim(s, c!.code.toLowerCase(), 'a@x.com')
    expect(r.ok).toBe(true)
    expect(r.token).toBeTruthy()
    // window is closed forever
    expect(await claimAvailable(s)).toBe(false)
    expect(await currentClaim(s, 'orb.local')).toBeNull()
    expect((await redeemClaim(s, c!.code, 'b@x.com')).error).toBe('already claimed')
    const { getUsers } = await import('./otp.ts')
    const users = await getUsers(s)
    expect(users).toHaveLength(1)
    expect(users[0]!.role).toBe('owner')
  })

  test('expired code is reminted, not honored', async () => {
    const s = memStore()
    const c = await currentClaim(s, 'orb.local')
    await s.putKv('claim:code', JSON.stringify({ code: c!.code, exp: Date.now() - 1 }))
    expect((await redeemClaim(s, c!.code, 'a@x.com')).error).toBe('code expired')
    const c2 = await currentClaim(s, 'orb.local')
    expect(c2!.code).not.toBe(c!.code)
  })
})
