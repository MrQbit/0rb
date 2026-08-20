import { describe, test, expect } from 'bun:test'
import { encryptBackup, decryptBackup, restoreBackup, type BackupPayload } from './backup.ts'

function memStore() {
  const kv = new Map<string, string>()
  return {
    kv,
    async getKv(k: string) { return kv.get(k) ?? null },
    async putKv(k: string, v: string) { kv.set(k, v) },
    async delKv(k: string) { kv.delete(k) },
    async scanKv(prefix: string) {
      return [...kv.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value }))
    },
  } as any
}

const PAYLOAD: BackupPayload = {
  version: 1, created_at: '2026-08-20T00:00:00Z',
  kv: [
    { key: 'auth:users', value: JSON.stringify([{ email: 'a@x.com', role: 'owner' }]) },
    { key: 'pins:a@x.com', value: '[{"id":"w1"}]' },
    { key: 'routines:all', value: '[]' },
  ],
  files: [], matter: null,
}

describe('backup', () => {
  test('round-trip: encrypt → decrypt bit-identical; wrong passphrase refused', () => {
    const blob = encryptBackup(PAYLOAD, 'correct horse battery')
    expect(decryptBackup(blob, 'correct horse battery')).toEqual(PAYLOAD)
    expect(() => decryptBackup(blob, 'wrong')).toThrow(/wrong passphrase/)
    expect(() => decryptBackup(Buffer.from('not a backup at all'), 'x')).toThrow(/not an .orbbackup/)
    // tamper with one ciphertext byte → GCM refuses
    const evil = Buffer.from(blob); evil[evil.length - 1] ^= 0xff
    expect(() => decryptBackup(evil, 'correct horse battery')).toThrow(/wrong passphrase/)
  })

  test('restore: export → wipe → import → state identical', async () => {
    const s = memStore()
    const blob = encryptBackup(PAYLOAD, 'pass-12345')
    s.kv.clear() // the wipe
    const r = await restoreBackup(s, decryptBackup(blob, 'pass-12345'))
    expect(r.kv).toBe(3)
    expect(await s.getKv('auth:users')).toBe(PAYLOAD.kv[0]!.value)
    expect(await s.getKv('pins:a@x.com')).toBe('[{"id":"w1"}]')
  })

  test('restore refuses path traversal in memory files', async () => {
    const s = memStore()
    const evil: BackupPayload = { ...PAYLOAD, kv: [], files: [{ path: '../../etc/passwd', b64: Buffer.from('x').toString('base64') }] }
    const r = await restoreBackup(s, evil)
    expect(r.files).toBe(0)
  })
})
