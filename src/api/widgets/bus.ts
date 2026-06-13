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
  for (const fn of set) { try { fn(spec) } catch { /* ignore */ } }
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
