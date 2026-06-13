/**
 * File-upload storage for /v1/files/*.
 *
 * Files are written to <FILES_ROOT>/<sessionId>/<subdir>/<safeName>
 * and indexed in Redis under orb2:file:<id> + orb2:file:idx:<sessionId>
 * (a JSON list of ids). The stored absolute path is what the worker
 * pod reads when the agent reads it with the Read tool -- the
 * upload root is mounted into the worker at the same path via the
 * shared PV.
 *
 * Access model:
 *   - Anyone with a valid auth context can upload to a session they
 *     "own" (apikey owner_oid match, or service identity in dev mode
 *     when auth is off).
 *   - Listing/reading a file requires the same owner_oid match, OR
 *     an admin key.
 *   - Deleting requires the same.
 *
 * Constraints:
 *   - Per-file size cap ORB2_FILES_MAX_BYTES (default 50 MB)
 *   - Per-session quota ORB2_FILES_QUOTA_BYTES (default 500 MB)
 *   - Filename sanitised (no '..', no path separators, no NUL)
 *   - SHA-256 of contents stored alongside metadata
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Store } from '../store/store.js'

export const DEFAULT_FILES_ROOT = '/var/orb2/files'
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024
export const DEFAULT_QUOTA_BYTES = 500 * 1024 * 1024

const FILE_KEY_PREFIX = 'orb2:file:'
const SESSION_INDEX_PREFIX = 'orb2:file:idx:'
// Global list of every session that has ever had a file uploaded.
// We append-only here and dedupe on read; the count stays bounded by
// the number of distinct sessions, not files.
const GLOBAL_SESSIONS_KEY = 'orb2:file:sessions'

export type StoredFileMeta = {
  id: string
  session_id: string
  owner_oid?: string
  name: string
  /** Absolute path the worker pod will read from. */
  path: string
  size: number
  sha256: string
  content_type: string
  uploaded_at: string
}

export type FilesConfig = {
  root: string
  maxBytesPerFile: number
  quotaBytesPerSession: number
  enabled: boolean
}

export function getFilesConfig(): FilesConfig {
  const enabled = process.env.ORB2_FILES_ENABLED !== '0'
  const root = process.env.ORB2_FILES_ROOT?.trim() || DEFAULT_FILES_ROOT
  const max = parseInt(process.env.ORB2_FILES_MAX_BYTES || '', 10)
  const quota = parseInt(process.env.ORB2_FILES_QUOTA_BYTES || '', 10)
  return {
    enabled,
    root,
    maxBytesPerFile: Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_BYTES,
    quotaBytesPerSession: Number.isFinite(quota) && quota > 0 ? quota : DEFAULT_QUOTA_BYTES,
  }
}

/** Strip path separators / control bytes / leading dots; keep extension. */
export function sanitizeFileName(name: string): string {
  const base = name.split('/').pop()!.split('\\').pop()!
  // Drop control chars + nul, keep printable ASCII + most unicode.
  // eslint-disable-next-line no-control-regex
  let cleaned = base.replace(/[\x00-\x1f\x7f]/g, '_').replace(/^\.+/, '')
  // Reject explicit traversal tokens.
  cleaned = cleaned.replace(/\.\.+/g, '.')
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'upload'
  // Hard cap the length so an absurdly long name can't blow the FS.
  return cleaned.slice(0, 200)
}

function sessionDir(cfg: FilesConfig, sessionId: string, subdir: string): string {
  const root = resolve(cfg.root)
  const safeSub = subdir.replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'uploads'
  const dir = resolve(root, sessionId, safeSub)
  if (!dir.startsWith(root)) {
    throw new Error('path traversal blocked')
  }
  return dir
}

async function readSessionIndex(store: Store, sessionId: string): Promise<string[]> {
  const raw = await store.getKv(`${SESSION_INDEX_PREFIX}${sessionId}`)
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []
  } catch { return [] }
}

async function writeSessionIndex(store: Store, sessionId: string, ids: string[]): Promise<void> {
  await store.putKv(
    `${SESSION_INDEX_PREFIX}${sessionId}`,
    JSON.stringify(Array.from(new Set(ids))),
    0,
  )
}

export async function getFileMeta(store: Store, id: string): Promise<StoredFileMeta | null> {
  if (!/^[a-f0-9-]{8,40}$/i.test(id)) return null
  const raw = await store.getKv(`${FILE_KEY_PREFIX}${id}`)
  if (!raw) return null
  try { return JSON.parse(raw) as StoredFileMeta } catch { return null }
}

export async function listSessionFiles(store: Store, sessionId: string): Promise<StoredFileMeta[]> {
  const ids = await readSessionIndex(store, sessionId)
  const out: StoredFileMeta[] = []
  for (const id of ids) {
    const m = await getFileMeta(store, id)
    if (m) out.push(m)
  }
  return out
}

async function sumSessionBytes(store: Store, sessionId: string): Promise<number> {
  const files = await listSessionFiles(store, sessionId)
  return files.reduce((acc, f) => acc + (f.size || 0), 0)
}

export type SaveFileInput = {
  sessionId: string
  ownerOid?: string
  name: string
  contentType: string
  bytes: Buffer
  subdir?: string
}

export async function saveFile(
  store: Store,
  input: SaveFileInput,
): Promise<StoredFileMeta> {
  const cfg = getFilesConfig()
  if (!cfg.enabled) throw new Error('File upload disabled')
  if (!input.sessionId || !/^[a-z0-9-]{4,128}$/i.test(input.sessionId)) {
    throw new Error('Invalid session_id')
  }
  if (input.bytes.length > cfg.maxBytesPerFile) {
    throw new Error(`File exceeds per-file limit (${cfg.maxBytesPerFile} bytes)`)
  }
  const used = await sumSessionBytes(store, input.sessionId)
  if (used + input.bytes.length > cfg.quotaBytesPerSession) {
    throw new Error(`Session quota exceeded (${cfg.quotaBytesPerSession} bytes)`)
  }
  const safeName = sanitizeFileName(input.name)
  const id = randomUUID().replace(/-/g, '').slice(0, 24)
  const dir = sessionDir(cfg, input.sessionId, input.subdir ?? 'uploads')
  mkdirSync(dir, { recursive: true })
  const fullPath = join(dir, `${id}-${safeName}`)
  writeFileSync(fullPath, input.bytes)
  const sha256 = createHash('sha256').update(input.bytes).digest('hex')
  const meta: StoredFileMeta = {
    id,
    session_id: input.sessionId,
    owner_oid: input.ownerOid,
    name: safeName,
    path: fullPath,
    size: input.bytes.length,
    sha256,
    content_type: input.contentType || 'application/octet-stream',
    uploaded_at: new Date().toISOString(),
  }
  await store.putKv(`${FILE_KEY_PREFIX}${id}`, JSON.stringify(meta), 0)
  const idx = await readSessionIndex(store, input.sessionId)
  idx.push(id)
  await writeSessionIndex(store, input.sessionId, idx)
  await rememberSessionInGlobalIndex(store, input.sessionId)
  return meta
}

async function rememberSessionInGlobalIndex(store: Store, sessionId: string): Promise<void> {
  try {
    const raw = await store.getKv(GLOBAL_SESSIONS_KEY)
    let arr: string[] = []
    try { arr = raw ? JSON.parse(raw) : [] } catch { arr = [] }
    if (arr.includes(sessionId)) return
    arr.push(sessionId)
    await store.putKv(GLOBAL_SESSIONS_KEY, JSON.stringify(arr.slice(-10000)), 0)
  } catch { /* best-effort */ }
}

export async function listAllFileSessions(store: Store): Promise<string[]> {
  const raw = await store.getKv(GLOBAL_SESSIONS_KEY)
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? Array.from(new Set(v.filter((x: unknown) => typeof x === 'string'))) : []
  } catch { return [] }
}

export async function listAllFiles(store: Store): Promise<StoredFileMeta[]> {
  const sids = await listAllFileSessions(store)
  const all: StoredFileMeta[] = []
  const perSession = await Promise.all(
    sids.map(sid => listSessionFiles(store, sid))
  )
  for (const arr of perSession) all.push(...arr)
  return all
}

export async function deleteFile(
  store: Store,
  id: string,
): Promise<StoredFileMeta | null> {
  const meta = await getFileMeta(store, id)
  if (!meta) return null
  try {
    if (existsSync(meta.path)) unlinkSync(meta.path)
    // Best-effort: try to drop the now-empty session subdir so we don't
    // leak directory entries forever.
    try {
      const parent = dirname(meta.path)
      const { readdirSync, rmdirSync } = require('node:fs') as typeof import('node:fs')
      if (readdirSync(parent).length === 0) rmdirSync(parent)
    } catch { /* keep */ }
  } catch { /* best effort */ }
  await store.delKv(`${FILE_KEY_PREFIX}${id}`)
  const idx = await readSessionIndex(store, meta.session_id)
  await writeSessionIndex(store, meta.session_id, idx.filter(x => x !== id))
  return meta
}

/** Read raw bytes back out (for GET /v1/files/{id}). */
export function readFileBytes(meta: StoredFileMeta): Buffer | null {
  try {
    if (!existsSync(meta.path)) return null
    const st = statSync(meta.path)
    if (!st.isFile()) return null
    return readFileSync(meta.path)
  } catch { return null }
}
