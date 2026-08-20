/**
 * Backup & migration (v0.2 S4). One passphrase-encrypted file carries the
 * household: users and roles, settings, pins, consent policy, receipts,
 * routines, memory (kv + the memory files on disk), device identity, and
 * the Matter fabric (via the sidecar, so Apple Home pairing survives a
 * rebuild). AES-256-GCM under an scrypt key — the file is equivalent to
 * house keys and the UI says so. Ephemera (session cost counters, vault
 * cursors) stay out on purpose.
 */
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, relative, resolve } from 'node:path'
import type { Store } from '../store/store.js'
import { log } from '../log.js'

const MAGIC = Buffer.from('ORBBK1\0')
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

/** Durable namespaces worth carrying to a new box. */
export const KV_PREFIXES = [
  'auth:', 'setting:', 'pins:', 'policy:', 'receipts:', 'routines:',
  'deck:', 'family:', 'devicecert:', 'remote:', 'firstrun:', 'provenance:',
  'home:', 'housemode', 'timers', 'presence:', 'wallet:', 'shopping:',
  'mem:', 'memory:', 'graph:',
]

export interface BackupPayload {
  version: 1
  created_at: string
  kv: Array<{ key: string; value: string }>
  files: Array<{ path: string; b64: string }>
  matter: { files: Array<{ path: string; b64: string }> } | null
}

function walkFiles(root: string): Array<{ path: string; b64: string }> {
  const out: Array<{ path: string; b64: string }> = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (st.size <= 2 * 1024 * 1024) out.push({ path: relative(root, p), b64: readFileSync(p).toString('base64') })
    }
  }
  try { walk(root) } catch { /* no memory dir yet */ }
  return out
}

function matterUrl(): string {
  return (process.env.ORB2_MATTER_URL || 'http://host.docker.internal:8998').replace(/\/+$/, '')
}

export async function buildBackup(store: Store): Promise<BackupPayload> {
  const kv: Array<{ key: string; value: string }> = []
  for (const prefix of KV_PREFIXES) kv.push(...await store.scanKv(prefix))
  // de-dupe (overlapping prefixes like 'home:'/'housemode')
  const seen = new Set<string>()
  const uniq = kv.filter(e => !seen.has(e.key) && seen.add(e.key))

  let files: BackupPayload['files'] = []
  try {
    const { getAutoMemPath } = await import('../memory/memPath.js')
    files = walkFiles(getAutoMemPath())
  } catch { /* memory optional */ }

  let matter: BackupPayload['matter'] = null
  try {
    const r = await fetch(`${matterUrl()}/export`, { signal: AbortSignal.timeout(8000) })
    if (r.ok) matter = await r.json() as any
  } catch { /* matter optional */ }

  return { version: 1, created_at: new Date().toISOString(), kv: uniq, files, matter }
}

export function encryptBackup(payload: BackupPayload, passphrase: string): Buffer {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(passphrase, salt, 32, SCRYPT)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), ct])
}

export function decryptBackup(blob: Buffer, passphrase: string): BackupPayload {
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not an .orbbackup file')
  const salt = blob.subarray(7, 23)
  const iv = blob.subarray(23, 35)
  const tag = blob.subarray(35, 51)
  const ct = blob.subarray(51)
  const key = scryptSync(passphrase, salt, 32, SCRYPT)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  let pt: Buffer
  try { pt = Buffer.concat([decipher.update(ct), decipher.final()]) }
  catch { throw new Error('wrong passphrase (or damaged file)') }
  const payload = JSON.parse(pt.toString('utf8')) as BackupPayload
  if (payload.version !== 1) throw new Error(`unsupported backup version ${(payload as any).version}`)
  return payload
}

export async function restoreBackup(store: Store, payload: BackupPayload): Promise<{ kv: number; files: number; matter: boolean }> {
  for (const { key, value } of payload.kv) await store.putKv(key, value, 0)

  let fileCount = 0
  try {
    const { getAutoMemPath } = await import('../memory/memPath.js')
    const root = resolve(getAutoMemPath())
    for (const f of payload.files) {
      const dest = resolve(root, f.path)
      if (!dest.startsWith(root)) continue  // no traversal out of the memory dir
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, Buffer.from(f.b64, 'base64'))
      fileCount++
    }
  } catch (e) { log.warn('backup_files_restore_failed', { error: (e as Error).message }) }

  let matterOk = false
  if (payload.matter?.files?.length) {
    try {
      const r = await fetch(`${matterUrl()}/import`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload.matter), signal: AbortSignal.timeout(15000),
      })
      matterOk = r.ok
    } catch { /* sidecar down — kv/files still restored */ }
  }
  return { kv: payload.kv.length, files: fileCount, matter: matterOk }
}
