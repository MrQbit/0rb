/**
 * Per-session widget bus. The Widget agent tool emits typed widget specs
 * here; the chat SSE stream and the voice WebSocket subscribe per session and
 * forward them to the client, which renders native floating widgets.
 *
 * In-memory + single-process — fine for the single-user box.
 */
export type WidgetSpec = {
  id?: string
  type: 'chart' | 'results' | 'video' | 'note' | string
  title?: string
  [k: string]: unknown
}

type Listener = (spec: WidgetSpec) => void
const listeners = new Map<string, Set<Listener>>()

export function emitWidget(sessionId: string, spec: WidgetSpec): void {
  const set = listeners.get(sessionId)
  if (!set) return
  // Catalog validation (v0.2 §5): unknown fields are stripped, unknown types
  // pass only for registered runtime plugins, attention tiers can only be
  // lowered. A skeleton (pending:true) skips field checks by design.
  let out = spec
  try {
    // require() keeps this hot path synchronous; both modules are local.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { validateSpec } = require('./catalog.js') as typeof import('./catalog.js')
    const { listPlugins } = require('./plugins.js') as typeof import('./plugins.js')
    const plugins = new Set(listPlugins().map((p: any) => p.type))
    const v = validateSpec(spec, t => plugins.has(t))
    if (!v.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[widgets] rejected spec: ${v.reason}`)
      return
    }
    out = v.spec as WidgetSpec
  } catch { /* validation is best-effort; never drop UI on internal errors */ }
  for (const fn of set) { try { fn(out) } catch { /* ignore */ } }
}

export function onWidget(sessionId: string, fn: Listener): () => void {
  let set = listeners.get(sessionId)
  if (!set) { set = new Set(); listeners.set(sessionId, set) }
  set.add(fn)
  return () => {
    const s = listeners.get(sessionId)
    if (s) { s.delete(fn); if (!s.size) listeners.delete(sessionId) }
  }
}
