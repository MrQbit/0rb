import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { bootstrapAdminKey } from './bootstrap.ts'

type Rec = {
  id: string
  ownerOid: string
  ownerEmail: string
  name: string
  admin?: boolean
  createdAt: string
}

function makeMemStore() {
  const map = new Map<string, Rec>()
  return {
    async putApiKey(hash: string, record: Rec) {
      map.set(hash, record)
    },
    async getApiKey(hash: string) {
      return map.get(hash) ?? null
    },
    async listAllApiKeys() {
      return Array.from(map.entries()).map(([hash, record]) => ({ hash, record }))
    },
    async delApiKey(hash: string) {
      map.delete(hash)
    },
    _map: map,
  } as any
}

const VALID = 'rak00n_' + 'a'.repeat(64)
const ORIG = process.env.RAK00N_BOOTSTRAP_ADMIN_KEY

describe('bootstrapAdminKey', () => {
  beforeEach(() => {
    delete process.env.RAK00N_BOOTSTRAP_ADMIN_KEY
  })
  afterEach(() => {
    if (ORIG === undefined) delete process.env.RAK00N_BOOTSTRAP_ADMIN_KEY
    else process.env.RAK00N_BOOTSTRAP_ADMIN_KEY = ORIG
  })

  test('no-op when env var is unset', async () => {
    const store = makeMemStore()
    await bootstrapAdminKey(store)
    expect((await store.listAllApiKeys()).length).toBe(0)
  })

  test('mints the first admin when env var is set and store has no admin', async () => {
    process.env.RAK00N_BOOTSTRAP_ADMIN_KEY = VALID
    const store = makeMemStore()
    await bootstrapAdminKey(store)
    const all = await store.listAllApiKeys()
    expect(all.length).toBe(1)
    expect(all[0]!.record.admin).toBe(true)
    expect(all[0]!.record.name).toBe('bootstrap-admin')
  })

  test('no-op when an admin already exists', async () => {
    process.env.RAK00N_BOOTSTRAP_ADMIN_KEY = VALID
    const store = makeMemStore()
    await store.putApiKey('preexisting', {
      id: 'pre',
      ownerOid: 'app:someone',
      ownerEmail: 'someone@x',
      name: 'pre',
      admin: true,
      createdAt: new Date().toISOString(),
    })
    await bootstrapAdminKey(store)
    const all = await store.listAllApiKeys()
    expect(all.length).toBe(1)
    expect(all[0]!.record.id).toBe('pre')
  })

  test('no-op when env var is malformed', async () => {
    process.env.RAK00N_BOOTSTRAP_ADMIN_KEY = 'not-a-rak00n-key'
    const store = makeMemStore()
    await bootstrapAdminKey(store)
    expect((await store.listAllApiKeys()).length).toBe(0)
  })
})
