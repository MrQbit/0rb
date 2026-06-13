/**
 * Cloud Storage operations — search and download files from the user's
 * connected Google Drive / Microsoft OneDrive into the session workspace.
 * OAuth + tokens live in cloudStorageOAuth.ts; this module is the thin API
 * layer (Google Drive v3 + Microsoft Graph v1.0) the agent tools call.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Store } from '../store/store.js'
import {
  type CloudProvider, CLOUD_PROVIDERS, getToken, isConnected,
  providerConfigured, anyCloudConfigured,
} from './cloudStorageOAuth.js'

export { anyCloudConfigured } from './cloudStorageOAuth.js'

export interface CloudFile {
  provider: CloudProvider
  id: string
  name: string
  mimeType?: string
  size?: number
  modified?: string
  webUrl?: string
  isFolder?: boolean
}

// Google Docs/Sheets/Slides are not binary blobs — they must be exported.
const GOOGLE_EXPORT: Record<string, { mime: string; ext: string }> = {
  'application/vnd.google-apps.document': { mime: 'application/pdf', ext: 'pdf' },
  'application/vnd.google-apps.spreadsheet': { mime: 'text/csv', ext: 'csv' },
  'application/vnd.google-apps.presentation': { mime: 'application/pdf', ext: 'pdf' },
}

/** Which providers are connected right now (have a usable token). */
export async function connectedProviders(store: Store): Promise<CloudProvider[]> {
  const out: CloudProvider[] = []
  for (const p of CLOUD_PROVIDERS) if (await isConnected(store, p)) out.push(p)
  return out
}

async function searchGoogle(store: Store, query: string, limit: number): Promise<CloudFile[]> {
  const tok = await getToken(store, 'google')
  if (!tok) return []
  const q = query.trim()
    ? `name contains '${query.replace(/'/g, "\\'")}' and trashed = false`
    : 'trashed = false'
  const params = new URLSearchParams({
    q, pageSize: String(limit), orderBy: 'modifiedTime desc',
    fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink)',
  })
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { authorization: `Bearer ${tok}` },
  })
  if (!r.ok) return []
  const d = (await r.json()) as any
  return (d.files || []).map((f: any): CloudFile => ({
    provider: 'google', id: f.id, name: f.name, mimeType: f.mimeType,
    size: f.size ? Number(f.size) : undefined, modified: f.modifiedTime, webUrl: f.webViewLink,
    isFolder: f.mimeType === 'application/vnd.google-apps.folder',
  }))
}

async function searchMicrosoft(store: Store, query: string, limit: number): Promise<CloudFile[]> {
  const tok = await getToken(store, 'microsoft')
  if (!tok) return []
  const url = query.trim()
    ? `https://graph.microsoft.com/v1.0/me/drive/root/search(q='${encodeURIComponent(query)}')?$top=${limit}`
    : `https://graph.microsoft.com/v1.0/me/drive/root/children?$top=${limit}&$orderby=lastModifiedDateTime desc`
  const r = await fetch(url, { headers: { authorization: `Bearer ${tok}` } })
  if (!r.ok) return []
  const d = (await r.json()) as any
  return (d.value || []).map((f: any): CloudFile => ({
    provider: 'microsoft', id: f.id, name: f.name, mimeType: f.file?.mimeType,
    size: f.size, modified: f.lastModifiedDateTime, webUrl: f.webUrl, isFolder: !!f.folder,
  }))
}

/** Search one provider (or all connected ones if provider is omitted). */
export async function searchCloud(
  store: Store, query: string, provider?: CloudProvider, limit = 15,
): Promise<CloudFile[]> {
  const targets = provider ? [provider] : await connectedProviders(store)
  const results = await Promise.all(targets.map(p =>
    (p === 'google' ? searchGoogle(store, query, limit) : searchMicrosoft(store, query, limit)).catch(() => []),
  ))
  return results.flat().slice(0, limit * targets.length)
}

/** Download a file into <workspace>/<sessionId>/cloud/<name>. Returns the saved path + a servable workspace URL. */
export async function downloadCloudFile(
  store: Store, provider: CloudProvider, fileId: string, sessionId: string, nameHint?: string,
): Promise<{ path: string; url: string; name: string }> {
  const tok = await getToken(store, provider)
  if (!tok) throw new Error(`${provider} is not connected`)

  let name = nameHint || fileId
  let fetchUrl: string
  let exportExt = ''

  if (provider === 'google') {
    // Look up the file's name + mimeType (to decide export vs. direct media).
    const metaR = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType`, {
      headers: { authorization: `Bearer ${tok}` },
    })
    if (!metaR.ok) throw new Error(`Google metadata failed (${metaR.status})`)
    const meta = (await metaR.json()) as any
    name = nameHint || meta.name || fileId
    const exp = GOOGLE_EXPORT[meta.mimeType as string]
    if (exp) {
      fetchUrl = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exp.mime)}`
      exportExt = exp.ext
    } else {
      fetchUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
    }
  } else {
    const metaR = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${fileId}?$select=name`, {
      headers: { authorization: `Bearer ${tok}` },
    })
    if (metaR.ok) { const meta = (await metaR.json()) as any; name = nameHint || meta.name || fileId }
    fetchUrl = `https://graph.microsoft.com/v1.0/me/drive/items/${fileId}/content`
  }

  if (exportExt && !name.toLowerCase().endsWith(`.${exportExt}`)) name = `${name}.${exportExt}`
  // Sanitise the filename (no path traversal).
  name = name.replace(/[/\\]/g, '_').replace(/^\.+/, '').slice(0, 200) || 'file'

  const res = await fetch(fetchUrl, { headers: { authorization: `Bearer ${tok}` } })
  if (!res.ok) throw new Error(`Download failed (${res.status})`)
  const buf = Buffer.from(await res.arrayBuffer())

  const wsRoot = process.env.RAK00N_API_WORKSPACE_ROOT || '/workspace'
  const dir = path.join(wsRoot, sessionId, 'cloud')
  mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, name)
  writeFileSync(dest, buf)
  return { path: dest, url: `/v1/workspace/${sessionId}/cloud/${encodeURIComponent(name)}`, name }
}

export function cloudStorageEnabled(): boolean { return anyCloudConfigured() }
export { providerConfigured }
