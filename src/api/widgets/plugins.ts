/**
 * Custom widget plugins — the runtime, no-recompile extension point.
 *
 * A plugin is a folder under the widgets dir:
 *   <widgetsDir>/<id>/
 *     manifest.json   { type, name, description?, icon?, width?, height?, category? }
 *     render.js       ES module exporting `render(el, spec, api)` (default or named)
 *
 * Drop a folder in → it shows up in the Apps registry and renders when the
 * agent (or anything) emits a Widget of that `type`. Nothing is recompiled or
 * re-shipped. On a consumer install the dir lives under the user's app data;
 * on the Spark it's the shared workspace volume.
 *
 * Trust model: render.js runs in the page (like the built-in renderers), so
 * plugins are owner-installed code on a single-user box. Keep that in mind
 * before adding a public "install from URL" path.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, normalize, resolve, sep } from 'node:path'

export interface WidgetPlugin {
  id: string
  type: string
  name: string
  description?: string
  icon?: string
  width?: number
  height?: number
  category?: string
}

export function widgetsDir(): string {
  if (process.env.ORB2_WIDGETS_DIR) return process.env.ORB2_WIDGETS_DIR
  const ws = process.env.ORB2_API_WORKSPACE_ROOT || process.cwd()
  return join(ws, '.widgets')
}

/** Scan the widgets dir and return one entry per valid plugin. */
export function listPlugins(): WidgetPlugin[] {
  const dir = widgetsDir()
  if (!existsSync(dir)) return []
  const out: WidgetPlugin[] = []
  for (const id of readdirSync(dir)) {
    try {
      const pdir = join(dir, id)
      if (!statSync(pdir).isDirectory()) continue
      const mf = join(pdir, 'manifest.json')
      if (!existsSync(mf) || !existsSync(join(pdir, 'render.js'))) continue
      const m = JSON.parse(readFileSync(mf, 'utf8'))
      const type = String(m.type || id).trim()
      if (!type) continue
      out.push({
        id,
        type,
        name: String(m.name || type),
        description: m.description ? String(m.description) : undefined,
        icon: m.icon ? String(m.icon) : '🧩',
        width: Number(m.width) || undefined,
        height: Number(m.height) || undefined,
        category: m.category ? String(m.category) : 'Custom',
      })
    } catch { /* skip malformed plugin */ }
  }
  return out
}

/**
 * Resolve a plugin file path safely (no traversal outside its own folder).
 * Returns { path, contentType } or null.
 */
export function pluginFile(id: string, file: string): { path: string; contentType: string } | null {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return null
  const base = resolve(join(widgetsDir(), id))
  const target = resolve(join(base, normalize(file)))
  if (target !== base && !target.startsWith(base + sep)) return null     // traversal guard
  if (!existsSync(target) || !statSync(target).isFile()) return null
  const ct = target.endsWith('.js') ? 'application/javascript'
    : target.endsWith('.css') ? 'text/css'
    : target.endsWith('.json') ? 'application/json'
    : target.endsWith('.svg') ? 'image/svg+xml'
    : 'application/octet-stream'
  return { path: target, contentType: ct }
}
