/**
 * A2A JSON-RPC 2.0 dispatcher.
 *
 * Implements the Agent-to-Agent task protocol:
 *   - tasks/send         — synchronous task execution (A2A v0.2 legacy)
 *   - tasks/sendSubscribe — streaming (SSE) task execution (v0.2 legacy)
 *   - tasks/get          — fetch task state by id
 *   - tasks/cancel       — abort a running task
 *   - message/send       — A2A v0.3 synchronous send (used by .NET SDK)
 *   - message/stream     — A2A v0.3 streaming send (used by .NET SDK)
 *
 * Each task wraps a single agentRunner.runAgentTurn() call. Task state
 * is persisted via the Store's putKv/getKv methods with a TTL matching
 * session TTL.
 */
import { randomUUID } from 'node:crypto'
import { runAgentTurn, type AgentRunHooks } from './agentRunner.js'
import { createSse, SSE_RESPONSE_HEADERS } from './sse.js'
import { log } from './log.js'
import { metrics } from './metrics.js'
import type { Store } from './store/store.js'
import type { CallerIdentity } from './auth/context.js'
import { attributionFor } from './auth/context.js'
import path from 'node:path'
import { mkdirSync } from 'node:fs'

// ─── Verb mapping (shared with server.ts via re-export) ───
const TOOL_VERBS: Record<string, string> = {
  Read: 'Reading', Edit: 'Editing', MultiEdit: 'Editing',
  Write: 'Creating', Create: 'Creating', Bash: 'Running',
  Grep: 'Searching', Glob: 'Scanning', LS: 'Listing',
  WebFetch: 'Fetching', WebSearch: 'Searching web',
  TodoWrite: 'Planning', Skill: 'Using skill', Agent: 'Delegating', Task: 'Delegating',
}
function toolVerb(name: string): string {
  if (TOOL_VERBS[name]) return TOOL_VERBS[name]
  if (name.startsWith('mcp__') || name.startsWith('mcp_')) return 'Calling'
  return 'Using'
}
function toolTarget(name: string, args: unknown): string {
  const a = args as Record<string, unknown> | null
  if (!a) return ''
  if (typeof a.file_path === 'string') return path.basename(a.file_path)
  if (typeof a.command === 'string') return (a.command as string).slice(0, 40)
  if (typeof a.pattern === 'string') return `'${(a.pattern as string).slice(0, 30)}'`
  if (typeof a.url === 'string') return (a.url as string).slice(0, 50)
  return ''
}
function summarizeThinking(text: string, maxLen = 120): string {
  const firstLine = text.split('\n').find(l => l.trim().length > 0) || ''
  return firstLine.length > maxLen ? firstLine.slice(0, maxLen) + '...' : firstLine
}

// ─────────── Types ───────────

type TaskState = 'submitted' | 'working' | 'completed' | 'failed' | 'canceled'

type TaskArtifact = {
  parts: { type: string; text?: string; data?: unknown }[]
}

type TaskRecord = {
  id: string
  sessionId: string
  status: { state: TaskState; message?: string }
  artifacts: TaskArtifact[]
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

type JsonRpcRequest = {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

type JsonRpcResponse = {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

type RuntimeCtx = {
  agentId: string
  store: Store
  sessionTtlSeconds: number
  audit: (e: Record<string, unknown>) => void
}

// ─────────── In-flight abort controllers ───────────
const inflight = new Map<string, AbortController>()

// ─────────── Store helpers ───────────
const TASK_KEY_PREFIX = 'a2a:task:'
const TASK_TTL = 86400

async function saveTask(store: Store, task: TaskRecord): Promise<void> {
  await store.putKv(
    `${TASK_KEY_PREFIX}${task.id}`,
    JSON.stringify(task),
    TASK_TTL,
  )
}

async function loadTask(store: Store, id: string): Promise<TaskRecord | null> {
  const raw = await store.getKv(`${TASK_KEY_PREFIX}${id}`)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function ensureDir(dir: string) {
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // already exists or permission denied (non-fatal)
  }
}

// ─────────── Main handler ───────────

export async function handleA2aRpc(
  req: Request,
  identity: CallerIdentity,
  ctx: RuntimeCtx,
): Promise<Response> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return rpcError(null, -32700, 'Parse error')
  }

  const rpc = body as JsonRpcRequest
  if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
    return rpcError(rpc.id ?? null, -32600, 'Invalid Request')
  }

  const mcpToken = extractUserBearer(req, rpc)

  switch (rpc.method) {
    case 'tasks/send':
      return handleTasksSend(rpc, identity, ctx, mcpToken)
    case 'tasks/sendSubscribe':
      return handleTasksSendSubscribe(rpc, identity, ctx, req, mcpToken)
    case 'tasks/get':
      return handleTasksGet(rpc, ctx)
    case 'tasks/cancel':
      return handleTasksCancel(rpc, ctx)
    case 'message/send':
      return handleMessageSend(rpc, identity, ctx, mcpToken)
    case 'message/stream':
      return handleMessageStream(rpc, identity, ctx, req, mcpToken)
    default:
      return rpcError(rpc.id ?? null, -32601, `Method not found: ${rpc.method}`)
  }
}

/**
 * Extract the end-user bearer JWT for forwarding to MCP servers.
 *
 * Resolution order:
 *   1. HTTP `Authorization: Bearer <jwt>` header (BFF passes the user
 *      JWT this way when AgentMessaging__ApiKey is empty).
 *   2. JSON-RPC `params.metadata.bearerToken` (BFF also embeds it
 *      here as a structural fallback for service-key deployments).
 *
 * `orb2_*` prefixed keys are Orb2 API keys, never user bearers, so
 * they are filtered out.
 */
function extractUserBearer(req: Request, rpc: JsonRpcRequest): string | undefined {
  const authHeader = req.headers.get('Authorization') ?? ''
  if (/^Bearer\s+/i.test(authHeader)) {
    const t = authHeader.replace(/^Bearer\s+/i, '').trim()
    if (t && !/^orb2_/i.test(t)) return t
  }
  const meta = (rpc.params as Record<string, unknown> | undefined)?.metadata as
    | Record<string, unknown>
    | undefined
  if (meta && typeof meta.bearerToken === 'string' && meta.bearerToken.length > 0) {
    return meta.bearerToken
  }
  return undefined
}

// ─────────── A2A v0.3 helpers ───────────

/**
 * Translate v0.3 `params.message` into the legacy v0.2 shape the
 * existing handlers consume:
 *   { id?, sessionId?, message: <text>, model?, metadata? }
 *
 * v0.3 request shape:
 *   params.message = {
 *     kind: 'message',
 *     role: 'user',
 *     parts: [{ kind:'text', text:'...' }, ...],
 *     messageId, contextId?, taskId?,
 *     metadata?: {...}
 *   }
 *   params.metadata?: {...}
 *   params.configuration?: {...}
 */
function liftV03ParamsToV02(params: Record<string, unknown>): Record<string, unknown> {
  const msg = params.message as Record<string, unknown> | undefined
  if (!msg || typeof msg !== 'object') return params

  const text = extractTextFromV03Message(msg)
  const taskId = (msg.taskId as string | undefined) ?? (params.id as string | undefined)
  const sessionId = (msg.contextId as string | undefined) ?? (params.sessionId as string | undefined)
  const lifted: Record<string, unknown> = {
    ...params,
    message: text ?? '',
  }
  if (taskId) lifted.id = taskId
  if (sessionId) lifted.sessionId = sessionId
  return lifted
}

function extractTextFromV03Message(msg: Record<string, unknown>): string | null {
  const parts = msg.parts
  if (!Array.isArray(parts)) return null
  const texts: string[] = []
  for (const p of parts) {
    if (p && typeof p === 'object' && typeof (p as any).text === 'string') {
      texts.push((p as any).text)
    }
  }
  const joined = texts.join('').trim()
  return joined.length > 0 ? joined : null
}

/**
 * Convert the internal v0.2 TaskRecord to the v0.3 Task shape the
 * .NET A2A SDK 0.3.x expects.
 */
function toV03Task(task: TaskRecord): Record<string, unknown> {
  return {
    kind: 'task',
    id: task.id,
    contextId: task.sessionId,
    status: {
      ...task.status,
      timestamp: task.updatedAt,
    },
    artifacts: task.artifacts.map((a, idx) => ({
      artifactId: `artifact-${idx}`,
      parts: a.parts.map(p => ({
        kind: p.type,
        ...(typeof p.text === 'string' ? { text: p.text } : {}),
        ...(p.data !== undefined ? { data: p.data } : {}),
      })),
    })),
    metadata: task.metadata,
  }
}

// ─────────── message/send (A2A v0.3, synchronous) ───────────

async function handleMessageSend(
  rpc: JsonRpcRequest,
  identity: CallerIdentity,
  ctx: RuntimeCtx,
  mcpToken: string | undefined,
): Promise<Response> {
  const params = liftV03ParamsToV02(rpc.params ?? {})
  if (!params.message || (params.message as string).length === 0) {
    return rpcError(rpc.id ?? null, -32602, 'params.message.parts must contain at least one text part')
  }

  // Run the legacy handler and unwrap its JSON-RPC envelope so we can
  // re-wrap with the v0.3 Task shape.
  const inner: JsonRpcRequest = { ...rpc, params, method: 'tasks/send' }
  const response = await handleTasksSend(inner, identity, ctx, mcpToken)
  const payload = (await response.json()) as JsonRpcResponse
  if (payload.error) {
    return rpcError(rpc.id ?? null, payload.error.code, payload.error.message, payload.error.data)
  }
  return rpcSuccess(rpc.id ?? null, toV03Task(payload.result as TaskRecord))
}

// ─────────── message/stream (A2A v0.3, streaming) ───────────

async function handleMessageStream(
  rpc: JsonRpcRequest,
  identity: CallerIdentity,
  ctx: RuntimeCtx,
  req: Request,
  mcpToken: string | undefined,
): Promise<Response> {
  const params = liftV03ParamsToV02(rpc.params ?? {})
  const message = params.message as string
  if (!message || message.length === 0) {
    return rpcError(rpc.id ?? null, -32602, 'params.message.parts must contain at least one text part')
  }

  const taskId = (params.id as string) || randomUUID()
  const sessionId = (params.sessionId as string) || randomUUID()
  const model = params.model as string | undefined
  const workspaceRoot = process.env.ORB2_API_WORKSPACE_ROOT || '/workspace'
  const workingDirectory = path.join(workspaceRoot, sessionId)
  ensureDir(workingDirectory)

  const task: TaskRecord = {
    id: taskId,
    sessionId,
    status: { state: 'submitted' },
    artifacts: [],
    metadata: { model },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  await saveTask(ctx.store, task)

  const abortController = new AbortController()
  inflight.set(taskId, abortController)
  req.signal?.addEventListener('abort', () => abortController.abort())

  const sse = createSse({ onAbort: () => abortController.abort() })

  // First frame: the initial Task (v0.3 SDKs read this to learn the task id)
  sse.send('', toV03Task(task))

  const previousMessages = (await ctx.store.getSession(sessionId)) ?? []
  const attribution = attributionFor(identity)

  ctx.audit({
    ...attribution,
    event: 'a2a.message.stream.started',
    data: { task_id: taskId, session_id: sessionId, model, streaming: true, mcp_token_forwarded: !!mcpToken },
  })
  metrics.streamOpened()

  ;(async () => {
    let artifactCounter = 0
    const toolCalls: unknown[] = []
    const toolResults: unknown[] = []

    sse.send('', {
      kind: 'status-update',
      taskId,
      contextId: sessionId,
      status: { state: 'working', timestamp: new Date().toISOString() },
      final: false,
    })

    const includeThinking = (params as any).include_thinking !== false
    const includeActivity = (params as any).include_activity !== false

    try {
      const hooks: AgentRunHooks = {
        onTextChunk: text => {
          sse.send('', {
            kind: 'artifact-update',
            taskId,
            contextId: sessionId,
            artifact: {
              artifactId: `artifact-text-${artifactCounter}`,
              parts: [{ kind: 'text', text }],
            },
            append: true,
            lastChunk: false,
          })
        },
        onToolStart: e => {
          metrics.recordTool(e.toolName)
          toolCalls.push(e)
          sse.send('', {
            kind: 'artifact-update',
            taskId,
            contextId: sessionId,
            artifact: {
              artifactId: `artifact-tool-${artifactCounter++}`,
              parts: [{ kind: 'data', data: { event: 'start', ...e } }],
            },
            append: false,
            lastChunk: true,
          })
          if (includeActivity) {
            sse.send('', {
              kind: 'activity',
              taskId,
              contextId: sessionId,
              verb: toolVerb(e.toolName),
              target: toolTarget(e.toolName, e.arguments),
              toolName: e.toolName,
              phase: 'start',
            })
          }
        },
        onToolResult: e => {
          toolResults.push(e)
          sse.send('', {
            kind: 'artifact-update',
            taskId,
            contextId: sessionId,
            artifact: {
              artifactId: `artifact-tool-${artifactCounter++}`,
              parts: [{ kind: 'data', data: { event: 'result', ...e } }],
            },
            append: false,
            lastChunk: true,
          })
          if (includeActivity) {
            sse.send('', {
              kind: 'activity',
              taskId,
              contextId: sessionId,
              verb: toolVerb(e.toolName),
              toolName: e.toolName,
              phase: e.isError ? 'error' : 'complete',
            })
          }
        },
        onThinking: includeThinking
          ? ev => { sse.send('', {
              kind: 'thinking',
              taskId,
              contextId: sessionId,
              text: ev.text,
              summary: summarizeThinking(ev.text),
            }) }
          : undefined,
        onLog: (l, m, d) => (log as any)[l]?.(m, d),
      }

      const result = await runAgentTurn(
        {
          message,
          model,
          workingDirectory,
          previousMessages,
          signal: abortController.signal,
          autoApprove: () => true,
          mcpToken,
        },
        hooks,
      )

      inflight.delete(taskId)
      metrics.streamClosed()

      await ctx.store.setSession(sessionId, result.finalMessages, ctx.sessionTtlSeconds)

      const finalState: TaskState = result.interrupted ? 'canceled' : 'completed'
      task.status = { state: finalState }
      task.artifacts = [{ parts: [{ type: 'text', text: result.fullText }] }]
      task.metadata = {
        ...task.metadata,
        session_id: sessionId,
        usage: {
          prompt_tokens: result.promptTokens,
          completion_tokens: result.completionTokens,
        },
      }
      task.updatedAt = new Date().toISOString()
      await saveTask(ctx.store, task)

      sse.send('', {
        kind: 'status-update',
        taskId,
        contextId: sessionId,
        status: { state: finalState, timestamp: task.updatedAt },
        final: true,
      })
      sse.close()

      ctx.audit({
        ...attribution,
        event: `a2a.message.stream.${finalState}`,
        data: { task_id: taskId, prompt_tokens: result.promptTokens, completion_tokens: result.completionTokens },
      })
    } catch (err) {
      inflight.delete(taskId)
      metrics.streamClosed()

      task.status = { state: 'failed', message: (err as Error).message }
      task.updatedAt = new Date().toISOString()
      await saveTask(ctx.store, task)

      sse.send('', {
        kind: 'status-update',
        taskId,
        contextId: sessionId,
        status: { state: 'failed', message: { kind: 'message', role: 'agent', parts: [{ kind: 'text', text: (err as Error).message }] }, timestamp: task.updatedAt },
        final: true,
      })
      sse.close()

      ctx.audit({
        ...attribution,
        event: 'a2a.message.stream.failed',
        data: { task_id: taskId, error: (err as Error).message },
      })
    }
  })()

  return new Response(sse.readable, {
    status: 200,
    headers: SSE_RESPONSE_HEADERS,
  })
}

// ─────────── tasks/send (synchronous) ───────────

async function handleTasksSend(
  rpc: JsonRpcRequest,
  identity: CallerIdentity,
  ctx: RuntimeCtx,
  mcpToken: string | undefined,
): Promise<Response> {
  const params = rpc.params ?? {}
  const message = extractMessage(params)
  if (!message) {
    return rpcError(rpc.id ?? null, -32602, 'params.message is required (string or message array with text content)')
  }

  const taskId = (params.id as string) || randomUUID()
  const sessionId = (params.sessionId as string) || randomUUID()
  const model = params.model as string | undefined
  const workspaceRoot = process.env.ORB2_API_WORKSPACE_ROOT || '/workspace'
  const workingDirectory = path.join(workspaceRoot, sessionId)
  ensureDir(workingDirectory)

  const task: TaskRecord = {
    id: taskId,
    sessionId,
    status: { state: 'submitted' },
    artifacts: [],
    metadata: { model },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  await saveTask(ctx.store, task)

  const abortController = new AbortController()
  inflight.set(taskId, abortController)

  task.status = { state: 'working' }
  task.updatedAt = new Date().toISOString()
  await saveTask(ctx.store, task)

  const previousMessages = (await ctx.store.getSession(sessionId)) ?? []
  const attribution = attributionFor(identity)
  const toolCalls: unknown[] = []
  const toolResults: unknown[] = []

  ctx.audit({
    ...attribution,
    event: 'a2a.task.started',
    data: { task_id: taskId, session_id: sessionId, model, mcp_token_forwarded: !!mcpToken },
  })
  metrics.streamOpened()

  try {
    const result = await runAgentTurn(
      {
        message,
        model,
        workingDirectory,
        previousMessages,
        signal: abortController.signal,
        autoApprove: () => true,
        mcpToken,
      },
      {
        onToolStart: e => {
          metrics.recordTool(e.toolName)
          toolCalls.push(e)
        },
        onToolResult: e => { toolResults.push(e) },
        onLog: (l, m, d) => (log as any)[l]?.(m, d),
      },
    )

    metrics.streamClosed()
    inflight.delete(taskId)

    await ctx.store.setSession(sessionId, result.finalMessages, ctx.sessionTtlSeconds)

    task.status = { state: result.interrupted ? 'canceled' : 'completed' }
    task.artifacts = [
      { parts: [{ type: 'text', text: result.fullText }] },
    ]
    if (toolCalls.length > 0) {
      task.artifacts.push({ parts: [{ type: 'data', data: { toolCalls, toolResults } }] })
    }
    task.metadata = {
      ...task.metadata,
      session_id: sessionId,
      usage: {
        prompt_tokens: result.promptTokens,
        completion_tokens: result.completionTokens,
      },
    }
    task.updatedAt = new Date().toISOString()
    await saveTask(ctx.store, task)

    ctx.audit({
      ...attribution,
      event: 'a2a.task.completed',
      data: { task_id: taskId, prompt_tokens: result.promptTokens, completion_tokens: result.completionTokens },
    })

    return rpcSuccess(rpc.id ?? null, task)
  } catch (err) {
    metrics.streamClosed()
    inflight.delete(taskId)

    task.status = { state: 'failed', message: (err as Error).message }
    task.updatedAt = new Date().toISOString()
    await saveTask(ctx.store, task)

    ctx.audit({
      ...attribution,
      event: 'a2a.task.failed',
      data: { task_id: taskId, error: (err as Error).message },
    })

    return rpcSuccess(rpc.id ?? null, task)
  }
}

// ─────────── tasks/sendSubscribe (streaming) ───────────

async function handleTasksSendSubscribe(
  rpc: JsonRpcRequest,
  identity: CallerIdentity,
  ctx: RuntimeCtx,
  req: Request,
  mcpToken: string | undefined,
): Promise<Response> {
  const params = rpc.params ?? {}
  const message = extractMessage(params)
  if (!message) {
    return rpcError(rpc.id ?? null, -32602, 'params.message is required (string or message array with text content)')
  }

  const taskId = (params.id as string) || randomUUID()
  const sessionId = (params.sessionId as string) || randomUUID()
  const model = params.model as string | undefined
  const workspaceRoot = process.env.ORB2_API_WORKSPACE_ROOT || '/workspace'
  const workingDirectory = path.join(workspaceRoot, sessionId)
  ensureDir(workingDirectory)

  const task: TaskRecord = {
    id: taskId,
    sessionId,
    status: { state: 'submitted' },
    artifacts: [],
    metadata: { model },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  await saveTask(ctx.store, task)

  const abortController = new AbortController()
  inflight.set(taskId, abortController)
  req.signal?.addEventListener('abort', () => abortController.abort())

  const sse = createSse({ onAbort: () => abortController.abort() })

  // Send initial task status
  sse.send('task/status', { id: taskId, status: { state: 'submitted' }, final: false })

  const previousMessages = (await ctx.store.getSession(sessionId)) ?? []
  const attribution = attributionFor(identity)

  ctx.audit({
    ...attribution,
    event: 'a2a.task.started',
    data: { task_id: taskId, session_id: sessionId, model, streaming: true, mcp_token_forwarded: !!mcpToken },
  })
  metrics.streamOpened()

  // Run agent in background, piping events to SSE
  ;(async () => {
    const toolCalls: unknown[] = []
    const toolResults: unknown[] = []

    sse.send('task/status', { id: taskId, status: { state: 'working' }, final: false })

    try {
      const hooks: AgentRunHooks = {
        onTextChunk: text => {
          sse.send('task/artifact', {
            id: taskId,
            artifact: { parts: [{ type: 'text', text }] },
            append: true,
          })
        },
        onToolStart: e => {
          metrics.recordTool(e.toolName)
          toolCalls.push(e)
          sse.send('task/tool', { id: taskId, event: 'start', ...e })
          sse.send('task/activity', { id: taskId, verb: toolVerb(e.toolName), target: toolTarget(e.toolName, e.arguments), toolName: e.toolName, phase: 'start' })
        },
        onToolResult: e => {
          toolResults.push(e)
          sse.send('task/tool', { id: taskId, event: 'result', ...e })
          sse.send('task/activity', { id: taskId, verb: toolVerb(e.toolName), toolName: e.toolName, phase: e.isError ? 'error' : 'complete' })
        },
        onThinking: ev => { sse.send('task/thinking', { id: taskId, text: ev.text, summary: summarizeThinking(ev.text) }) },
        onLog: (l, m, d) => (log as any)[l]?.(m, d),
      }

      const result = await runAgentTurn(
        {
          message,
          model,
          workingDirectory,
          previousMessages,
          signal: abortController.signal,
          autoApprove: () => true,
          mcpToken,
        },
        hooks,
      )

      inflight.delete(taskId)
      metrics.streamClosed()

      await ctx.store.setSession(sessionId, result.finalMessages, ctx.sessionTtlSeconds)

      const finalState: TaskState = result.interrupted ? 'canceled' : 'completed'
      task.status = { state: finalState }
      task.artifacts = [{ parts: [{ type: 'text', text: result.fullText }] }]
      task.metadata = {
        ...task.metadata,
        session_id: sessionId,
        usage: {
          prompt_tokens: result.promptTokens,
          completion_tokens: result.completionTokens,
        },
      }
      task.updatedAt = new Date().toISOString()
      await saveTask(ctx.store, task)

      sse.send('task/status', { id: taskId, status: task.status, final: true })
      sse.close()

      ctx.audit({
        ...attribution,
        event: `a2a.task.${finalState}`,
        data: { task_id: taskId, prompt_tokens: result.promptTokens, completion_tokens: result.completionTokens },
      })
    } catch (err) {
      inflight.delete(taskId)
      metrics.streamClosed()

      task.status = { state: 'failed', message: (err as Error).message }
      task.updatedAt = new Date().toISOString()
      await saveTask(ctx.store, task)

      sse.send('task/status', { id: taskId, status: task.status, final: true })
      sse.close()

      ctx.audit({
        ...attribution,
        event: 'a2a.task.failed',
        data: { task_id: taskId, error: (err as Error).message },
      })
    }
  })()

  return new Response(sse.readable, {
    status: 200,
    headers: SSE_RESPONSE_HEADERS,
  })
}

// ─────────── tasks/get ───────────

async function handleTasksGet(
  rpc: JsonRpcRequest,
  ctx: RuntimeCtx,
): Promise<Response> {
  const taskId = (rpc.params?.id as string) ?? ''
  if (!taskId) {
    return rpcError(rpc.id ?? null, -32602, 'params.id is required')
  }
  const task = await loadTask(ctx.store, taskId)
  if (!task) {
    return rpcError(rpc.id ?? null, -32001, 'Task not found')
  }
  return rpcSuccess(rpc.id ?? null, task)
}

// ─────────── tasks/cancel ───────────

async function handleTasksCancel(
  rpc: JsonRpcRequest,
  ctx: RuntimeCtx,
): Promise<Response> {
  const taskId = (rpc.params?.id as string) ?? ''
  if (!taskId) {
    return rpcError(rpc.id ?? null, -32602, 'params.id is required')
  }

  const controller = inflight.get(taskId)
  if (controller) {
    controller.abort()
    inflight.delete(taskId)
  }

  const task = await loadTask(ctx.store, taskId)
  if (!task) {
    return rpcError(rpc.id ?? null, -32001, 'Task not found')
  }

  if (task.status.state === 'working' || task.status.state === 'submitted') {
    task.status = { state: 'canceled' }
    task.updatedAt = new Date().toISOString()
    await saveTask(ctx.store, task)
  }

  return rpcSuccess(rpc.id ?? null, task)
}

// ─────────── Helpers ───────────

function extractMessage(params: Record<string, unknown>): string | null {
  if (typeof params.message === 'string' && params.message.length > 0) {
    return params.message
  }
  // A2A spec allows messages as an array of {role, parts[{type,text}]}
  if (Array.isArray(params.messages)) {
    const texts: string[] = []
    for (const msg of params.messages) {
      if (typeof msg === 'string') { texts.push(msg); continue }
      if (msg && typeof msg === 'object') {
        if (typeof (msg as any).content === 'string') {
          texts.push((msg as any).content)
        } else if (Array.isArray((msg as any).parts)) {
          for (const p of (msg as any).parts) {
            if (p && typeof p.text === 'string') texts.push(p.text)
          }
        }
      }
    }
    const joined = texts.join('\n').trim()
    return joined.length > 0 ? joined : null
  }
  return null
}

function rpcSuccess(id: string | number | null, result: unknown): Response {
  const body: JsonRpcResponse = { jsonrpc: '2.0', id, result }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): Response {
  const body: JsonRpcResponse = {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
