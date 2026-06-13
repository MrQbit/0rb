/**
 * Transport-agnostic agent runner.
 *
 * Delegates each turn to `runCleanTurn` (engineAdapter.ts) with a tool registry
 * built by `buildToolRegistry` (toolProvider.ts). The public contract —
 * `AgentRunInput`, `AgentRunHooks`, `AgentRunResult`, `runAgentTurn`,
 * `runAgentTurnWithFallback` — is shared by every caller (server.ts,
 * channels/runtime.ts, workerDispatch, a2a, jobs, vault, memory).
 *
 * Not yet wired (input fields remain so call-sites stay stable):
 *   - Skill matching + sticky-skill persistence (./skills/*).
 *   - On-demand MCP server connection + tool injection (./skills/mcpConnect,
 *     ./mcp/defaultServers, userMcpServers).
 *   - Task-packet preface (validatePacket / runWithTaskPacket).
 *   - Cross-turn TodoWrite write-through (todos flow through the native
 *     TodoWrite tool + todoStore).
 */
import { runCleanTurn } from './engineAdapter.js'
import { buildToolRegistry } from './toolProvider.js'
import type { SkillDefinition as Skill } from './skills/loader.js'
import type { SkillMcpServer } from './skills/loader.js'

// Re-export the resolver type for callers that reference it. The engine no
// longer calls into these art-side hooks, but the shape is kept so existing
// `hooks.resolvers = {...}` call-sites type-check during the migration.
export type AgentRunResolvers = {
  matchSkill?: (message: string) => Skill | null
  getEnabledSkills?: () => Skill[]
  connectSkillMcpServers?: (...args: any[]) => any
  isConnectionError?: (err: unknown) => boolean
  getDefaultMcpServersForMessage?: (message: string) => SkillMcpServer[]
  isModelFailure?: (result: { fullText?: string }) => boolean
}

export type AgentRunInput = {
  message: string
  workingDirectory?: string
  model?: string
  /** Per-turn provider/model override from the model router (cloud routing). */
  providerOverride?: { model: string; baseURL: string; apiKey: string }
  taskPacketJson?: string
  /** Previous Anthropic-format messages from prior turns (or empty) */
  previousMessages?: any[]
  signal?: AbortSignal
  /** Per-key allowlist. Undefined means "expose every tool". */
  allowedTools?: ReadonlySet<string>
  /** Per-key auto-approve rule (single-user orb auto-allows by default). */
  autoApprove?: (toolName: string, input: unknown) => boolean | undefined
  /** User bearer token for MCP server authentication. */
  mcpToken?: string
  sessionId?: string
  stickySkillStore?: {
    getActiveSkill(sessionId: string): Promise<string | null>
    setActiveSkill(sessionId: string, skillName: string): Promise<void>
  }
  todoStore?: {
    getTodos(sessionId: string): Promise<any | null>
    setTodos(sessionId: string, todos: any): Promise<void>
  }
  outputStyle?: string
  thinkingBudget?: number
  planMode?: boolean
  denyTools?: string[]
  agentId?: string
  worktree?: { branch?: string; root?: string }
  appendSystemPromptExtra?: string
  /** Ordered fallback model IDs tried on 503/529 (see runAgentTurnWithFallback). */
  fallbackModels?: string[]
  userMcpServers?: SkillMcpServer[]
  /**
   * API-native tools (Widget, Weather, Docker, Maps, Cloud, Vault, jobs…)
   * built via buildApiNativeTools() with API-process state bound. Merged with
   * the built-in core file tools to form the turn's tool registry.
   */
  extraTools?: any[]
}

export type AgentRunHooks = {
  onTextChunk?: (text: string) => void | Promise<void>
  onToolStart?: (event: {
    toolName: string
    arguments: unknown
    toolUseId: string
  }) => void | Promise<void>
  onToolResult?: (event: {
    toolName: string
    toolUseId: string
    output: string
    isError: boolean
  }) => void | Promise<void>
  onThinking?: (event: { text: string }) => void | Promise<void>
  onActionRequired?: (event: {
    promptId: string
    question: string
    type: 'CONFIRM_COMMAND' | 'REQUEST_INFORMATION'
  }) => Promise<string>
  onLog?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void
  resolvers?: AgentRunResolvers
}

export type AgentRunResult = {
  fullText: string
  promptTokens: number
  completionTokens: number
  finalMessages: any[]
  interrupted: boolean
  usedModel?: string
}

/**
 * Run a single agent turn end-to-end on the agent core.
 *
 *   1. Build the tool registry (built-in core tools + extraTools),
 *      filtered by the per-key allow/deny lists.
 *   2. Compose the system prompt from appendSystemPromptExtra (orb2's
 *      persona/context — see agentContext.ts).
 *   3. Run the agent loop, streaming text + tool events out via hooks.
 *   4. Return final text, tokens, and the final message array for resumption.
 */
export async function runAgentTurn(
  input: AgentRunInput,
  hooks: AgentRunHooks = {},
): Promise<AgentRunResult> {
  // --- Tool registry ------------------------------------------------------
  const registry = await buildToolRegistry(input.extraTools ?? [])

  // Apply per-key allowlist + per-request deny list by wrapping the registry.
  const denySet = new Set(input.denyTools ?? [])
  const allowed = input.allowedTools
  const permitted = (name: string) =>
    (!allowed || allowed.has(name)) && !denySet.has(name)

  const filtered = (allowed || denySet.size > 0)
    ? {
        list: () => registry.list().filter(t => permitted(t.name)),
        get: (n: string) => (permitted(n) ? registry.get(n) : undefined),
        has: (n: string) => permitted(n) && registry.has(n),
        call: async (n: string, i: any) =>
          permitted(n) ? registry.call(n, i) : `Tool ${n} is not allowed for this key`,
      }
    : registry

  // --- System prompt ------------------------------------------------------
  // appendSystemPromptExtra carries orb2's persona + grounding (date,
  // Widget guidance, plugin list). On the agent core — which has no orb2
  // base prompt of its own — this becomes the full system prompt.
  const systemPrompt = input.appendSystemPromptExtra?.trim() || undefined

  // --- Cancellation -------------------------------------------------------
  // The loop doesn't expose mid-flight interrupt; we honour an
  // already-aborted signal up front and tag the result. (Recovery TODO:
  // thread AbortSignal into the loop's stream fetch.)
  let interrupted = false
  if (input.signal?.aborted) interrupted = true

  const turnStartedAt = Date.now()
  hooks.onLog?.('info', 'engine_loop_start', {
    model: input.model ?? null,
    messageLen: input.message.length,
    previousMessageCount: input.previousMessages?.length ?? 0,
    totalToolCount: filtered.list().length,
    providerOverride: input.providerOverride ? input.providerOverride.model : null,
    workingDirectory: input.workingDirectory ?? null,
  })

  let result
  try {
    result = await runCleanTurn({
      message: input.message,
      model: input.model,
      systemPrompt,
      registry: filtered,
      previousMessages: input.previousMessages,
      providerOverride: input.providerOverride,
      onText: hooks.onTextChunk ? (c: string) => { void hooks.onTextChunk?.(c) } : undefined,
      onToolStart: hooks.onToolStart
        ? (e: { tool: string }) => { void hooks.onToolStart?.({ toolName: e.tool, arguments: {}, toolUseId: '' }) }
        : undefined,
      onToolResult: hooks.onToolResult
        ? (e: { tool: string; output: string }) =>
            { void hooks.onToolResult?.({ toolName: e.tool, toolUseId: '', output: e.output, isError: false }) }
        : undefined,
      onThinking: hooks.onThinking
        ? (e: { text: string }) => { void hooks.onThinking?.({ text: e.text }) }
        : undefined,
    })
  } catch (err) {
    hooks.onLog?.('error', 'agent_turn_error', {
      error: (err as Error).message,
      durationMs: Date.now() - turnStartedAt,
    })
    throw err
  }

  hooks.onLog?.('info', 'engine_loop_end', {
    durationMs: Date.now() - turnStartedAt,
    interrupted,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    toolCalls: result.toolCalls.length,
    finalTextLen: result.fullText.length,
  })

  return {
    fullText: result.fullText,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    finalMessages: result.finalMessages,
    interrupted,
    usedModel: input.model,
  }
}

/**
 * Run an agent turn with automatic model fallback on failure.
 *
 * Tries the primary model first. If the turn produces no usable output
 * (zero tokens / error indicator per `isModelFailure`), retries sequentially
 * through `input.fallbackModels`. With no fallbackModels, identical to
 * `runAgentTurn`.
 */
export async function runAgentTurnWithFallback(
  input: AgentRunInput,
  hooks: AgentRunHooks = {},
): Promise<AgentRunResult> {
  const chain = input.fallbackModels ?? []
  const isModelFailure =
    hooks.resolvers?.isModelFailure ??
    ((r: { fullText?: string; promptTokens?: number; completionTokens?: number }) =>
      (!r.fullText || r.fullText.trim().length === 0) &&
      !r.promptTokens && !r.completionTokens)

  const result = await runAgentTurn(input, hooks)
  if (chain.length === 0 || !isModelFailure(result)) return result

  hooks.onLog?.('warn', 'model_fallback_chain_start', {
    primaryModel: input.model ?? 'default',
    failedText: result.fullText.slice(0, 200),
    chain,
  })

  for (const fallbackModel of chain) {
    hooks.onLog?.('info', 'model_fallback_attempt', { model: fallbackModel, sessionId: input.sessionId })
    if (hooks.onTextChunk) {
      await hooks.onTextChunk(
        `\n\n[Model ${input.model ?? 'default'} unavailable — retrying with ${fallbackModel}]\n\n`,
      )
    }

    const fallbackResult = await runAgentTurn(
      { ...input, model: fallbackModel, fallbackModels: [] },
      hooks,
    )
    if (!isModelFailure(fallbackResult)) {
      hooks.onLog?.('info', 'model_fallback_succeeded', { model: fallbackModel })
      fallbackResult.usedModel = fallbackModel
      return fallbackResult
    }
    hooks.onLog?.('warn', 'model_fallback_failed', { model: fallbackModel, text: fallbackResult.fullText.slice(0, 200) })
  }

  hooks.onLog?.('error', 'model_fallback_chain_exhausted', {
    modelsAttempted: [input.model, ...chain],
  })
  return result
}
