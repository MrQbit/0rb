import { describe, test, expect } from 'bun:test'
import { authorizeSpend, recordSpend, recordSpendDenied, setAutoTier, getSpendPolicy, setSpendPolicy, getWeekSpend, getEarned, isoWeek, EARN_AT } from './policy.ts'

function memStore() {
  const kv = new Map<string, string>()
  return {
    async getKv(k: string) { return kv.get(k) ?? null },
    async putKv(k: string, v: string) { kv.set(k, v) },
    async delKv(k: string) { kv.delete(k) },
  } as any
}
const REQ = (over: any = {}) => ({ member: 'a@x.com', category: 'food' as const, amountCents: 3000, service: 'sim-eats', summary: 'lunch', ...over })

describe('spend policy (SPEC §1)', () => {
  test('defaults: modest food order asks; ceiling refuses; gifts always ask', async () => {
    const s = memStore()
    expect((await authorizeSpend(s, REQ())).decision).toBe('ask')
    expect((await authorizeSpend(s, REQ({ amountCents: 13000 }))).decision).toBe('refused')
    await setAutoTier(s, 'gifts' as any, true)   // must be a no-op
    expect((await authorizeSpend(s, REQ({ category: 'gifts', amountCents: 500 }))).decision).toBe('ask')
  })

  test('weekly cap refuses with honest numbers', async () => {
    const s = memStore()
    await setSpendPolicy(s, { weeklyCapCents: 5000 })
    await recordSpend(s, REQ({ amountCents: 4000 }), 'approved')
    const d = await authorizeSpend(s, REQ({ amountCents: 2000 }))
    expect(d.decision).toBe('refused')
    expect((d as any).reason).toContain('$50.00')
    expect((await getWeekSpend(s)).totalCents).toBe(4000)
  })

  test('earned ladder: N approvals → offer → auto under askUnder only; denial resets', async () => {
    const s = memStore()
    let offer = { offerAuto: false }
    for (let i = 0; i < EARN_AT; i++) offer = await recordSpend(s, REQ({ amountCents: 2000 }), 'approved')
    expect(offer.offerAuto).toBe(true)
    await setAutoTier(s, 'food', true)
    expect((await authorizeSpend(s, REQ({ amountCents: 2000 }))).decision).toBe('auto')
    expect((await authorizeSpend(s, REQ({ amountCents: 9000 }))).decision).toBe('ask')  // over askUnder
    await recordSpendDenied(s, 'food')
    expect((await getEarned(s, 'food')).count).toBe(0)
    expect((await authorizeSpend(s, REQ({ amountCents: 2000 }))).decision).toBe('auto') // auto persists until revoked
    await setAutoTier(s, 'food', false)
    expect((await authorizeSpend(s, REQ({ amountCents: 2000 }))).decision).toBe('ask')
  })

  test('member with commerce disabled is refused gracefully', async () => {
    const s = memStore()
    const { addUser, getUsers } = await import('../auth/otp.ts')
    await addUser(s, { email: 'kid@x.com', role: 'member' })
    const users = await getUsers(s)
    users.find(u => u.email === 'kid@x.com')!.disabled_apps = ['commerce']
    await s.putKv('auth:users', JSON.stringify(users))
    const d = await authorizeSpend(s, REQ({ member: 'kid@x.com' }))
    expect(d.decision).toBe('refused')
    expect((d as any).reason).toContain('profile')
  })

  test('isoWeek is stable across a week boundary shape', () => {
    expect(isoWeek(new Date('2026-01-01'))).toMatch(/^\d{4}-W\d{2}$/)
    expect(isoWeek(new Date('2026-12-31'))).toMatch(/^\d{4}-W\d{2}$/)
  })
})
