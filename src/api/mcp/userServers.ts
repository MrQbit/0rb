/**
 * Per-deployment user-registered MCP servers.
 *
 * Operators can register stand-alone MCPs (not bundled with a skill)
 * through POST /v1/mcps. Entries are persisted in Redis under
 * `rak00n:mcp:user:<name>` and an index `rak00n:mcp:user:index` keeps the
 * list small without scanning Redis.
 *
 * User-registered MCPs are merged into every chat turn (after the
 * keyword-gated built-in defaults, before skill-bundled servers so a
 * skill-specific MCP with the same name still wins).
 */
import type { Store } from '../store/store.js'
import type { SkillMcpServer } from '../skills/loader.js'

const USER_MCP_PREFIX = 'rak00n:mcp:user:'
const USER_MCP_INDEX = 'rak00n:mcp:user:index'
const MCP_TTL_SECONDS = 86_400 * 365 // ~ a year

export type UserMcpServer = SkillMcpServer & {
  registered_at: string
  registered_by?: string
}

function isValidServer(v: unknown): v is SkillMcpServer {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    typeof o.name === 'string' &&
    /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(o.name) &&
    typeof o.url === 'string' &&
    o.url.length > 0 &&
    typeof o.transport === 'string'
  )
}

async function readIndex(store: Store): Promise<string[]> {
  const raw = await store.getKv(USER_MCP_INDEX)
  try { return raw ? JSON.parse(raw) as string[] : [] } catch { return [] }
}

async function writeIndex(store: Store, names: string[]): Promise<void> {
  await store.putKv(USER_MCP_INDEX, JSON.stringify(names), MCP_TTL_SECONDS)
}

export async function listUserMcpServers(store: Store): Promise<UserMcpServer[]> {
  const names = await readIndex(store)
  const out: UserMcpServer[] = []
  for (const n of names) {
    const raw = await store.getKv(USER_MCP_PREFIX + n)
    if (!raw) continue
    try { out.push(JSON.parse(raw) as UserMcpServer) } catch { /* skip corrupt */ }
  }
  return out
}

export async function saveUserMcpServer(
  store: Store,
  server: SkillMcpServer,
  registeredBy?: string,
): Promise<UserMcpServer> {
  if (!isValidServer(server)) {
    throw new Error('Invalid MCP server payload: name, url and transport are required; name must match [a-z0-9_-]{1,64}')
  }
  const record: UserMcpServer = {
    name: server.name,
    url: server.url,
    transport: server.transport,
    headers: server.headers || {},
    registered_at: new Date().toISOString(),
    registered_by: registeredBy,
  }
  await store.putKv(USER_MCP_PREFIX + record.name, JSON.stringify(record), MCP_TTL_SECONDS)
  const idx = await readIndex(store)
  if (!idx.includes(record.name)) {
    idx.push(record.name)
    await writeIndex(store, idx)
  }
  return record
}

export async function deleteUserMcpServer(store: Store, name: string): Promise<boolean> {
  const idx = await readIndex(store)
  const filtered = idx.filter(n => n !== name)
  if (filtered.length === idx.length) return false
  await writeIndex(store, filtered)
  await store.delKv(USER_MCP_PREFIX + name)
  return true
}

export async function getUserMcpServer(store: Store, name: string): Promise<UserMcpServer | null> {
  const raw = await store.getKv(USER_MCP_PREFIX + name)
  if (!raw) return null
  try { return JSON.parse(raw) as UserMcpServer } catch { return null }
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers || {})) {
    if (!v) { out[k] = ''; continue }
    if (v.startsWith('${') && v.endsWith('}')) {
      // Template placeholder — keep visible.
      out[k] = v
    } else {
      out[k] = v.length <= 4 ? '***' : `${v.slice(0, 2)}***${v.slice(-2)}`
    }
  }
  return out
}

export function toRedactedView(server: SkillMcpServer & { origin: string; source_repo?: string }) {
  return {
    name: server.name,
    url: server.url,
    transport: server.transport,
    headers: redactHeaders(server.headers || {}),
    origin: server.origin,
    source_repo: server.source_repo,
  }
}
