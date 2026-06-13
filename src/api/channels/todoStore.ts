/**
 * Channel todo store — persists the agent's task list AND mirrors it live to a
 * console-styled `todo` widget. The agent already uses TodoWrite proactively
 * for multi-step / long-running work (research, coding); every update re-emits
 * the same widget id, so the task list opens when work begins and ticks along
 * as the agent makes progress.
 */
import type { Store } from '../store/store.js'
import { emitWidget } from '../widgets/bus.js'

/** Local todo shape (was orb2-core's TodoList). The native TodoWrite tool
 *  produces this; we persist + mirror it to the `todo` widget. */
export type TodoItem = {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}
export type TodoList = TodoItem[]

export function makeChannelTodoStore(store: Store) {
  return {
    async getTodos(sessionId: string): Promise<TodoList | null> {
      try {
        const v = await store.getKv(`todos:${sessionId}`)
        return v ? (JSON.parse(v) as TodoList) : null
      } catch {
        return null
      }
    },
    async setTodos(sessionId: string, todos: TodoList): Promise<void> {
      try { await store.putKv(`todos:${sessionId}`, JSON.stringify(todos ?? []), 86400) } catch { /* best effort */ }
      try {
        const items = (todos ?? []).map(t => ({
          // show the present-continuous form for the active task, imperative otherwise
          text: t.status === 'in_progress' ? (t.activeForm || t.content) : t.content,
          status: t.status,
        }))
        const done = items.filter(i => i.status === 'completed').length
        emitWidget(sessionId, {
          id: 'todos',
          type: 'todo',
          title: 'Tasks',
          items,
          pill: items.length ? `${done}/${items.length} done` : 'tasks',
        } as any)
      } catch { /* widget bus best effort */ }
    },
  }
}
