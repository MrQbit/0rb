/**
 * /v1/files/* endpoints.
 *
 *   POST   /v1/files                 multipart/form-data upload
 *                                    fields: file (one or many),
 *                                            session_id (optional),
 *                                            subdir (optional)
 *   GET    /v1/files?session_id=...  list metadata
 *   GET    /v1/files/{id}            stream contents
 *   GET    /v1/files/{id}/meta       metadata only
 *   DELETE /v1/files/{id}            remove
 *
 * Caller must have either:
 *   - admin api key, OR
 *   - api key whose owner_oid matches the file's owner_oid, OR
 *   - service identity (dev mode without auth)
 */
import type { CallerIdentity } from '../auth/context.js'
import {
  deleteFile,
  getFileMeta,
  getFilesConfig,
  listAllFiles,
  listSessionFiles,
  readFileBytes,
  saveFile,
  type StoredFileMeta,
} from './storage.js'
import type { Store } from '../store/store.js'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function ownerOidOf(identity: CallerIdentity): string | undefined {
  if (identity.type === 'apikey') return identity.record.ownerOid
  return undefined
}

function canRead(meta: StoredFileMeta, identity: CallerIdentity, isAdmin: boolean): boolean {
  if (isAdmin) return true
  if (!meta.owner_oid) return true
  return ownerOidOf(identity) === meta.owner_oid
}

async function resolveOwnerEmails(store: Store, oids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (oids.length === 0) return out
  try {
    const all = await store.listAllApiKeys()
    for (const k of all) {
      if (k.record.ownerOid && k.record.ownerEmail && oids.includes(k.record.ownerOid)) {
        if (!out.has(k.record.ownerOid)) {
          out.set(k.record.ownerOid, k.record.ownerEmail)
        }
      }
    }
  } catch { /* fall through with empty map */ }
  return out
}

type AuditFn = (entry: {
  oid?: string
  keyId?: string
  event: string
  data?: Record<string, unknown>
}) => void

export async function tryHandleFilesRoute(
  req: Request,
  pathname: string,
  identity: CallerIdentity,
  store: Store,
  isAdmin: (id: CallerIdentity) => boolean,
  audit: AuditFn,
  attributionFor: (id: CallerIdentity) => { oid?: string; keyId?: string },
): Promise<Response | null> {
  if (!pathname.startsWith('/v1/files')) return null
  const cfg = getFilesConfig()
  if (!cfg.enabled) {
    return jsonResponse(503, { error: 'File upload disabled', code: 'FILES_DISABLED' })
  }
  const method = req.method
  const attr = attributionFor(identity)

  // POST /v1/files (multipart)
  if (method === 'POST' && pathname === '/v1/files') {
    let form: FormData
    try {
      form = await req.formData()
    } catch (err) {
      return jsonResponse(400, {
        error: 'multipart/form-data body required',
        detail: (err as Error).message,
      })
    }
    const sessionIdRaw = form.get('session_id')
    const subdirRaw = form.get('subdir')
    const sessionId = (typeof sessionIdRaw === 'string' && sessionIdRaw.trim())
      ? sessionIdRaw.trim()
      : crypto.randomUUID()
    const subdir = typeof subdirRaw === 'string' ? subdirRaw.trim() : undefined
    const owner = ownerOidOf(identity)
    const out: StoredFileMeta[] = []
    const errors: { name: string; error: string }[] = []
    const parts: { name: string; file: File }[] = []
    for (const [k, v] of form.entries()) {
      if (k === 'file' || k === 'files') {
        if (typeof v !== 'string') {
          const fv = v as File
          parts.push({ name: fv.name || 'upload', file: fv })
        }
      }
    }
    if (parts.length === 0) {
      return jsonResponse(400, { error: 'no file parts in multipart body' })
    }
    for (const p of parts) {
      try {
        const ab = await p.file.arrayBuffer()
        const meta = await saveFile(store, {
          sessionId,
          ownerOid: owner,
          name: p.name,
          contentType: p.file.type || 'application/octet-stream',
          bytes: Buffer.from(ab),
          subdir,
        })
        audit({
          ...attr,
          event: 'file.uploaded',
          data: {
            file_id: meta.id,
            session_id: sessionId,
            size: meta.size,
            sha256: meta.sha256,
            content_type: meta.content_type,
          },
        })
        out.push(meta)
      } catch (err) {
        errors.push({ name: p.name, error: (err as Error).message })
      }
    }
    return jsonResponse(out.length > 0 ? 201 : 400, {
      session_id: sessionId,
      files: out.map(m => ({
        id: m.id,
        name: m.name,
        size: m.size,
        sha256: m.sha256,
        content_type: m.content_type,
        path: m.path,
        uploaded_at: m.uploaded_at,
      })),
      errors: errors.length ? errors : undefined,
    })
  }

  // GET /v1/files/all  — admin-wide rollup across every session.
  // Surfaced in the Settings → Files admin pane; service identity in
  // a no-auth dev deployment is treated as admin (consistent with
  // /v1/audit + /v1/cost behaviour). Returns files newest-first plus
  // top-level totals so the UI can render summary cards without a
  // second round trip.
  if (method === 'GET' && pathname === '/v1/files/all') {
    if (!isAdmin(identity) && identity.type === 'apikey') {
      return jsonResponse(403, { error: 'admin only' })
    }
    const all = await listAllFiles(store)
    all.sort((a, b) => (b.uploaded_at || '').localeCompare(a.uploaded_at || ''))
    let totalBytes = 0
    const sessions = new Set<string>()
    const owners = new Set<string>()
    for (const m of all) {
      totalBytes += m.size || 0
      if (m.session_id) sessions.add(m.session_id)
      if (m.owner_oid) owners.add(m.owner_oid)
    }
    const ownerEmailMap = await resolveOwnerEmails(store, Array.from(owners))
    return jsonResponse(200, {
      total_files: all.length,
      total_bytes: totalBytes,
      sessions: sessions.size,
      owners: owners.size,
      files: all.map(m => ({
        id: m.id,
        session_id: m.session_id,
        owner_oid: m.owner_oid ?? null,
        owner_email: m.owner_oid ? (ownerEmailMap.get(m.owner_oid) ?? null) : null,
        name: m.name,
        size: m.size,
        sha256: m.sha256,
        content_type: m.content_type,
        path: m.path,
        uploaded_at: m.uploaded_at,
      })),
    })
  }

  // GET /v1/files?session_id=...
  if (method === 'GET' && pathname === '/v1/files') {
    const url = new URL(req.url)
    const sid = url.searchParams.get('session_id')?.trim()
    if (!sid) return jsonResponse(400, { error: 'session_id query required' })
    const all = await listSessionFiles(store, sid)
    const visible = all.filter(m => canRead(m, identity, isAdmin(identity)))
    return jsonResponse(200, {
      session_id: sid,
      files: visible.map(m => ({
        id: m.id,
        name: m.name,
        size: m.size,
        sha256: m.sha256,
        content_type: m.content_type,
        path: m.path,
        uploaded_at: m.uploaded_at,
      })),
    })
  }

  // GET /v1/files/{id}/meta
  const metaMatch = pathname.match(/^\/v1\/files\/([a-f0-9]{8,40})\/meta$/i)
  if (method === 'GET' && metaMatch) {
    const meta = await getFileMeta(store, metaMatch[1]!)
    if (!meta) return jsonResponse(404, { error: 'Not found' })
    if (!canRead(meta, identity, isAdmin(identity))) {
      return jsonResponse(403, { error: 'Forbidden' })
    }
    return jsonResponse(200, meta)
  }

  // GET /v1/files/{id} (download)
  const dlMatch = pathname.match(/^\/v1\/files\/([a-f0-9]{8,40})$/i)
  if (method === 'GET' && dlMatch) {
    const meta = await getFileMeta(store, dlMatch[1]!)
    if (!meta) return jsonResponse(404, { error: 'Not found' })
    if (!canRead(meta, identity, isAdmin(identity))) {
      return jsonResponse(403, { error: 'Forbidden' })
    }
    const bytes = readFileBytes(meta)
    if (!bytes) return jsonResponse(410, { error: 'File missing on disk' })
    return new Response(bytes as any, {
      status: 200,
      headers: {
        'content-type': meta.content_type,
        'content-length': String(bytes.length),
        'content-disposition': `attachment; filename="${meta.name.replace(/"/g, '')}"`,
      },
    })
  }

  // DELETE /v1/files/{id}
  if (method === 'DELETE' && dlMatch) {
    const meta = await getFileMeta(store, dlMatch[1]!)
    if (!meta) return jsonResponse(404, { error: 'Not found' })
    if (!canRead(meta, identity, isAdmin(identity))) {
      return jsonResponse(403, { error: 'Forbidden' })
    }
    await deleteFile(store, dlMatch[1]!)
    audit({
      ...attr,
      event: 'file.deleted',
      data: { file_id: meta.id, session_id: meta.session_id, size: meta.size },
    })
    return jsonResponse(200, { deleted: meta.id })
  }

  return null
}
