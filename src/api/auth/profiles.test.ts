import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createInvite, acceptInvite, readInvite, listInvites } from './invites.ts'
import { updateUser, getUsers, displayName } from './otp.ts'
import { appOf, disabledMessage, APP_GROUPS } from './appGroups.ts'

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

describe('profiles v2', () => {
  test('invite: mint → read → accept creates member with name; single-use', async () => {
    const s = memStore()
    const inv = await createInvite(s, 'owner@x.com', 'for grandma')
    expect((await readInvite(s, inv.token))?.note).toBe('for grandma')
    expect(await listInvites(s)).toHaveLength(1)
    const r = await acceptInvite(s, inv.token, 'Grandma@X.com', 'Rosa')
    expect(r.ok).toBe(true)
    const u = (await getUsers(s)).find(x => x.email === 'grandma@x.com')!
    expect(u.role).toBe('member')
    expect(u.first_name).toBe('Rosa')
    expect(displayName(u)).toBe('Rosa')
    // burned: second accept fails
    expect((await acceptInvite(s, inv.token, 'other@x.com')).ok).toBe(false)
  })

  test('expired invite refuses', async () => {
    const s = memStore()
    const inv = await createInvite(s, 'owner@x.com')
    await s.putKv(`invite:${inv.token}`, JSON.stringify({ ...inv, expires_at: Date.now() - 1 }))
    expect((await acceptInvite(s, inv.token, 'a@x.com')).ok).toBe(false)
    expect(await listInvites(s)).toHaveLength(0)
  })

  test('profile updates persist; app groups map tools; message is kind', async () => {
    const s = memStore()
    const inv = await createInvite(s, 'o@x.com')
    await acceptInvite(s, inv.token, 'kid@x.com', 'Leo')
    await updateUser(s, 'kid@x.com', { last_name: 'Ausilio', disabled_apps: ['shopping'] })
    const u = (await getUsers(s)).find(x => x.email === 'kid@x.com')!
    expect(displayName(u)).toBe('Leo Ausilio')
    expect(u.disabled_apps).toEqual(['shopping'])
    expect(appOf('Shopping')).toBe('shopping')
    expect(appOf('Wallet')).toBe('shopping')
    expect(appOf('MusicPlay')).toBe('music')
    expect(appOf('Weather')).toBeUndefined()      // core, never restricted
    expect(disabledMessage('Shopping')).toContain('Shopping & purchases')
    expect(disabledMessage('Shopping')).toContain('Settings')
    for (const id of Object.keys(APP_GROUPS)) expect(id).toMatch(/^[a-z]+$/)
  })
})
