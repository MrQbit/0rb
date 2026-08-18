/**
 * Tool provider — unifies Orb's API-native tools (Widget, Weather, Maps, Music,
 * Calendar, the household ones…) with the small built-in file tools (memory
 * keeps MEMORY.md + notes via Read/Write/Edit/List), exposing the
 * `{ list, get, has, call }` registry the agent loop drives.
 *
 * Two tool families with different shapes are merged here:
 *  - built-in core tools (core/tools.ts): `description` is a string, JSON
 *    schema is `inputSchema`, `call(input)` returns a string.
 *  - API-native tools (apiNativeTools.ts): `description()` is async, JSON
 *    schema is `inputJSONSchema`, `call(input)` returns `{ data: string }`.
 * We normalize both into one registry whose `list()` is synchronous (the loop
 * calls it that way) — so descriptions are resolved up-front, which is why
 * building the registry is async.
 */
import { CORE_TOOLS } from './core/tools.js'

export interface ToolRegistry {
  list: () => Array<{ name: string; description: string; input_schema: any }>
  get: (n: string) => any
  has: (n: string) => boolean
  call: (n: string, input: any) => Promise<string>
}

interface AnyTool {
  name: string
  description?: string | (() => string | Promise<string>)
  inputSchema?: any
  input_schema?: any
  inputJSONSchema?: any
  call: (input: any, toolUseID?: string) => Promise<any>
}

/** The built-in core file tools every turn gets. */
const CLEAN_TOOLS: AnyTool[] = [...CORE_TOOLS].filter(Boolean)

/**
 * Synchronous catalog of the built-in core tools, for listing endpoints
 * (/v1/tools, the A2A agent card) and existence checks.
 */
export function cleanToolDefs(): Array<{ name: string; description: string; input_schema: any }> {
  return CLEAN_TOOLS.map(t => ({
    name: t.name,
    description: typeof t.description === 'string' ? t.description : '',
    input_schema: t.input_schema ?? t.inputSchema ?? { type: 'object', properties: {} },
  }))
}

function normalizeResult(res: any): string {
  if (typeof res === 'string') return res
  // API-native tools (apiNativeTools.ts) return { data: string }.
  if (res && typeof res.data === 'string') return res.data
  if (res && typeof res.content === 'string') return res.content
  if (res && Array.isArray(res.content)) return res.content.map((c: any) => c?.text ?? '').join('')
  return JSON.stringify(res?.content ?? res ?? '')
}

async function resolveDescription(t: AnyTool): Promise<string> {
  const d = t.description
  if (typeof d === 'function') {
    try { return String(await d.call(t)) } catch { return '' }
  }
  return d ?? ''
}

/**
 * Build the engine tool registry for a turn from the clean tools plus any
 * caller-supplied API-native tools (built via buildApiNativeTools and passed
 * as `extraTools`). Descriptions are resolved eagerly so `list()` is sync.
 */
export async function buildToolRegistry(extraTools: AnyTool[] = []): Promise<ToolRegistry> {
  const all = [...CLEAN_TOOLS, ...(extraTools ?? [])].filter(Boolean)
  const entries = await Promise.all(all.map(async t => ({
    name: t.name,
    description: await resolveDescription(t),
    input_schema: t.input_schema ?? t.inputJSONSchema ?? t.inputSchema ?? { type: 'object', properties: {} },
    tool: t,
  })))
  const byName = new Map(entries.map(e => [e.name, e]))

  // Some models emit method-style tool names ("Home.op", "Home.control")
  // instead of the registered name. Resolve tolerantly: strip the dotted
  // suffix when the prefix is a registered tool, and if the suffix is a
  // valid value of an enum property the input doesn't already set (e.g.
  // "Home.control" → Home with op:"control"), fold it into the input.
  function resolve(n: string, input: any): { entry?: (typeof entries)[number]; input: any } {
    const direct = byName.get(n)
    if (direct) return { entry: direct, input }
    const dot = n.indexOf('.')
    if (dot <= 0) return { input }
    const entry = byName.get(n.slice(0, dot))
    if (!entry) return { input }
    const suffix = n.slice(dot + 1)
    const props: Record<string, any> = (entry.input_schema as any)?.properties ?? {}
    if (!(suffix in props)) {
      for (const [key, prop] of Object.entries(props)) {
        if (Array.isArray((prop as any)?.enum) && (prop as any).enum.includes(suffix) && (input == null || input[key] === undefined)) {
          input = { ...(input ?? {}), [key]: suffix }
          break
        }
      }
    }
    return { entry, input }
  }

  return {
    list: () => entries.map(e => ({ name: e.name, description: e.description, input_schema: e.input_schema })),
    get: (n: string) => byName.get(n)?.tool,
    has: (n: string) => byName.has(n),
    call: async (n: string, input: any) => {
      const { entry, input: args } = resolve(n, input)
      if (!entry) return `Unknown tool: ${n}`
      try { return normalizeResult(await entry.tool.call(args ?? {}, `tu-${Date.now().toString(36)}`)) }
      catch (err) { return `Tool error: ${(err as Error).message}` }
    },
  }
}
