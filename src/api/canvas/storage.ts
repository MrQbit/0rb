/**
 * Canvas snapshot storage — persists working directory state to object
 * storage so sessions can be resumed after the canvas pod is destroyed.
 *
 * The upper layer of the overlayfs mount (only user-modified files) is
 * tarred with zstd compression and uploaded. On resume, the snapshot is
 * downloaded and extracted over the template's overlayfs lower layer.
 *
 * Provider abstraction supports Azure Blob Storage and S3-compatible
 * backends. Configured via ORB2_CANVAS_STORAGE_URL:
 *   - az://container/prefix  → Azure Blob
 *   - s3://bucket/prefix     → S3-compatible
 *   - file:///path           → Local filesystem (dev/testing)
 */

export interface CanvasSnapshotStore {
  upload(sessionId: string, data: Buffer): Promise<string>
  download(snapshotUrl: string): Promise<Buffer>
  delete(snapshotUrl: string): Promise<void>
  list(sessionId: string): Promise<{ url: string; createdAt: string; sizeBytes: number }[]>
}

export class LocalSnapshotStore implements CanvasSnapshotStore {
  constructor(private readonly root: string) {}

  async upload(sessionId: string, data: Buffer): Promise<string> {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = join(this.root, sessionId)
    mkdirSync(dir, { recursive: true })
    const name = `${Date.now()}.tar.zst`
    const path = join(dir, name)
    writeFileSync(path, data)
    return `file://${path}`
  }

  async download(snapshotUrl: string): Promise<Buffer> {
    const { readFileSync } = await import('node:fs')
    const path = snapshotUrl.replace('file://', '')
    return readFileSync(path) as unknown as Buffer
  }

  async delete(snapshotUrl: string): Promise<void> {
    const { unlinkSync } = await import('node:fs')
    const path = snapshotUrl.replace('file://', '')
    try { unlinkSync(path) } catch { /* ignore missing */ }
  }

  async list(sessionId: string): Promise<{ url: string; createdAt: string; sizeBytes: number }[]> {
    const { readdirSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = join(this.root, sessionId)
    try {
      return readdirSync(dir)
        .filter(f => f.endsWith('.tar.zst'))
        .map(f => {
          const p = join(dir, f)
          const s = statSync(p)
          return { url: `file://${p}`, createdAt: s.mtime.toISOString(), sizeBytes: s.size }
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    } catch {
      return []
    }
  }
}

export function createSnapshotStore(): CanvasSnapshotStore {
  const url = process.env.ORB2_CANVAS_STORAGE_URL || 'file:///var/orb2/canvas-snapshots'

  if (url.startsWith('file://')) {
    return new LocalSnapshotStore(url.replace('file://', ''))
  }

  // Azure Blob and S3 implementations would go here. For now, fall back
  // to local storage with a warning.
  console.warn(`[canvas] unsupported storage URL scheme: ${url}; falling back to local`)
  return new LocalSnapshotStore('/var/orb2/canvas-snapshots')
}
