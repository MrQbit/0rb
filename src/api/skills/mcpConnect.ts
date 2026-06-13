import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { SkillMcpServer } from './loader.js'

/**
 * Minimal structural MCP connection type (was orb2-core's MCPServerConnection).
 * Only the fields this module and its callers actually read are modelled.
 */
export type MCPServerConnection = {
  type: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
  name: string
  client?: Client
  capabilities?: Record<string, unknown>
  config?: unknown
  cleanup?: () => Promise<void>
  error?: string
}

const CONNECT_MAX_RETRIES = 3
const CONNECT_BASE_DELAY_MS = 1000
const CONNECT_TIMEOUT_MS = 30_000

export type ReconnectableMCPConnection = MCPServerConnection & {
  reconnect: () => Promise<boolean>
}

export type SkillMcpResult = {
  connections: ReconnectableMCPConnection[]
  cleanup: () => Promise<void>
}

function resolveTemplate(template: string, tokenOverride?: string): string {
  return template.replace(/\$\{([^}]+)\}/g, (_, key) => {
    if (key === 'MCP_SERVER_TOKEN' && tokenOverride) return tokenOverride
    return process.env[key] || ''
  })
}

export function isConnectionError(err: unknown): boolean {
  const msg = (err as Error)?.message?.toLowerCase() || ''
  return (
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('socket hang up') ||
    msg.includes('timeout') ||
    msg.includes('aborted') ||
    msg.includes('fetch failed') ||
    msg.includes('terminated') ||
    (msg.includes('connection') && (msg.includes('lost') || msg.includes('closed') || msg.includes('refused')))
  )
}

function createTransport(
  url: string,
  headers: Record<string, string>,
  serverName: string,
  tokenOverride?: string,
): StreamableHTTPClientTransport {
  const transport = new StreamableHTTPClientTransport(
    new URL(url),
    {
      requestInit: {
        headers: {
          ...headers,
          'User-Agent': 'orb2-api/skill-mcp',
        },
      },
    },
  )

  // Wrap transport.send to:
  //   1. Inject `_meta.bearer_token` into JSON-RPC params on every
  //      request (not notifications) when a forwarded user token is
  //      available. Some Fabric MCP servers (platform-workspaces,
  //      developer-journey) read the token from the payload in
  //      addition to the Authorization header. Servers that don't
  //      care silently ignore unknown `_meta` keys per the MCP spec.
  //   2. Tolerate servers that reject `notifications/initialized`
  //      (some Fabric MCP servers return "Method not found" instead
  //      of 202).
  const originalSend = transport.send.bind(transport)
  transport.send = async (message: any, options?: any) => {
    const isNotification =
      !Array.isArray(message) &&
      message?.id === undefined &&
      typeof message?.method === 'string'

    if (
      tokenOverride &&
      !Array.isArray(message) &&
      typeof message === 'object' &&
      message !== null &&
      typeof message.method === 'string' &&
      !isNotification
    ) {
      const params =
        typeof message.params === 'object' && message.params !== null
          ? message.params
          : {}
      const meta =
        typeof params._meta === 'object' && params._meta !== null
          ? params._meta
          : {}
      if (typeof meta.bearer_token !== 'string' || meta.bearer_token.length === 0) {
        message.params = { ...params, _meta: { ...meta, bearer_token: tokenOverride } }
      }
    }

    const isInitNotification =
      !Array.isArray(message) &&
      message?.method === 'notifications/initialized' &&
      message?.id === undefined
    if (isInitNotification) {
      try {
        return await originalSend(message, options)
      } catch (err) {
        console.warn(`[mcp] ${serverName}: notifications/initialized rejected (non-fatal): ${(err as Error).message}`)
        return
      }
    }
    return originalSend(message, options)
  }

  return transport
}

async function connectWithRetry(
  url: string,
  headers: Record<string, string>,
  serverName: string,
  tokenOverride?: string,
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  let lastErr: Error | null = null
  for (let attempt = 0; attempt <= CONNECT_MAX_RETRIES; attempt++) {
    const transport = createTransport(url, headers, serverName, tokenOverride)
    const client = new Client(
      { name: 'orb2', version: '0.2.0' },
      { capabilities: {} },
    )
    try {
      await client.connect(transport)
      return { client, transport }
    } catch (err) {
      lastErr = err as Error
      try { await client.close() } catch { /* ignore */ }
      if (attempt === CONNECT_MAX_RETRIES) break
      const delay = CONNECT_BASE_DELAY_MS * Math.pow(2, attempt)
      console.warn(`[mcp] ${serverName}: connect attempt ${attempt + 1}/${CONNECT_MAX_RETRIES} failed, retry in ${delay}ms: ${lastErr.message}`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw lastErr!
}

export async function connectSkillMcpServers(
  servers: SkillMcpServer[],
  tokenOverride?: string,
): Promise<SkillMcpResult> {
  const connections: ReconnectableMCPConnection[] = []
  const cleanupFns: (() => Promise<void>)[] = []

  for (const server of servers) {
    const resolvedUrl = resolveTemplate(server.url, tokenOverride)
    const resolvedHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(server.headers)) {
      resolvedHeaders[k] = resolveTemplate(v, tokenOverride)
    }

    // Empty bearer-token Authorization header → drop it and try the
    // connection anonymously. Some public MCP servers (e.g. PDF /
    // viewer tooling) allow unauthenticated tool discovery, and we
    // want the agent to see them even when no MCP_SERVER_TOKEN is
    // configured. The server itself decides whether to 401.
    if (resolvedHeaders['Authorization'] === 'Bearer ' || resolvedHeaders['Authorization'] === 'Bearer') {
      delete resolvedHeaders['Authorization']
      console.warn(
        `[mcp] ${server.name}: no MCP_SERVER_TOKEN — attempting anonymous connection`,
      )
    }

    try {
      const { client } = await connectWithRetry(resolvedUrl, resolvedHeaders, server.name, tokenOverride)
      const capabilities = client.getServerCapabilities() || {}

      const conn: ReconnectableMCPConnection = {
        type: 'connected',
        name: server.name,
        capabilities,
        client,
        config: {
          type: 'url' as const,
          url: resolvedUrl,
          scope: 'dynamic' as const,
        } as any,
        cleanup: async () => {
          try { await client.close() } catch { /* ignore */ }
        },
        reconnect: async () => {
          try {
            try { await conn.client.close() } catch { /* ignore */ }
            const result = await connectWithRetry(resolvedUrl, resolvedHeaders, server.name, tokenOverride)
            ;(conn as any).client = result.client
            ;(conn as any).type = 'connected'
            conn.cleanup = async () => {
              try { await result.client.close() } catch { /* ignore */ }
            }
            console.info(`[mcp] ${server.name}: reconnected successfully`)
            return true
          } catch (err) {
            console.error(`[mcp] ${server.name}: reconnect failed: ${(err as Error).message}`)
            return false
          }
        },
      }

      connections.push(conn)
      cleanupFns.push(conn.cleanup)
    } catch (err) {
      console.error(`[mcp] Failed to connect ${server.name}: ${(err as Error).message}`)
      const noopReconnect = async () => false
      connections.push({
        type: 'failed',
        name: server.name,
        error: (err as Error).message,
        config: {
          type: 'url' as const,
          url: resolvedUrl,
          scope: 'dynamic' as const,
        } as any,
        reconnect: noopReconnect,
      } as ReconnectableMCPConnection)
    }
  }

  return {
    connections,
    cleanup: async () => {
      await Promise.allSettled(cleanupFns.map(fn => fn()))
    },
  }
}
