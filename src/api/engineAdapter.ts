/**
 * Turn adapter — the bridge the rest of Orb's API runs on. A turn takes a
 * message + a tool registry + optional history and per-turn provider override
 * (the model router), runs the agent loop with tool execution, streams text,
 * and returns the final text + messages.
 *
 * Provider override is applied by setting OPENAI_BASE_URL/KEY/model for the
 * turn — fine for the single-user orb where turns are effectively serialized.
 */
import { createAgentLoop } from './core/agentLoop.js'

export interface ToolRegistry {
  list: () => Array<{ name: string; description: string; input_schema: any }>
  get: (n: string) => any
  has: (n: string) => boolean
  call: (n: string, input: any) => Promise<string>
}

export interface RunCleanInput {
  message: string
  model?: string
  systemPrompt?: string
  registry?: ToolRegistry
  previousMessages?: any[]
  providerOverride?: { model: string; baseURL: string; apiKey: string }
  onText?: (chunk: string) => void
  onToolStart?: (e: { tool: string }) => void
  onToolResult?: (e: { tool: string; output: string }) => void
  onThinking?: (e: { text: string }) => void
  /** Stream text deltas (true) vs. wait for the full block (false). Defaults
   *  to true when onText is supplied so voice/chat get incremental output. */
  stream?: boolean
  maxTurns?: number
}

export interface RunCleanResult {
  fullText: string
  finalMessages: any[]
  toolCalls: string[]
  promptTokens: number
  completionTokens: number
}

const EMPTY_REGISTRY: ToolRegistry = { list: () => [], get: () => null, has: () => false, call: async () => '' }

/** Normalize prior messages into the loop's OpenAI message form, preserving
 *  assistant tool_calls and tool-result messages so multi-turn tool use replays
 *  correctly. Legacy block-array content is flattened to text. */
function normalizeHistory(msgs: any[]): any[] {
  if (!Array.isArray(msgs)) return []
  const out: any[] = []
  for (const m of msgs) {
    const role = m?.role || 'user'
    // Tool result message (role:'tool' with tool_call_id).
    if (role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: flattenContent(m.content) })
      continue
    }
    const msg: any = { role, content: typeof m?.content === 'string' ? m.content : flattenContent(m?.content) }
    if (Array.isArray(m?.tool_calls) && m.tool_calls.length) msg.tool_calls = m.tool_calls
    out.push(msg)
  }
  return out
}

/** Reduce string | block-array content to a plain string. */
function flattenContent(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((b: any) => (typeof b === 'string' ? b : b?.text ?? '')).join('')
  }
  return String(content ?? '')
}

export async function runCleanTurn(input: RunCleanInput): Promise<RunCleanResult> {
  const savedBase = process.env.OPENAI_BASE_URL
  const savedKey = process.env.OPENAI_API_KEY
  let model = input.model || process.env.OPENAI_MODEL || 'qwen3-coder-next'
  if (input.providerOverride) {
    process.env.OPENAI_BASE_URL = input.providerOverride.baseURL
    process.env.OPENAI_API_KEY = input.providerOverride.apiKey
    model = input.providerOverride.model
  }
  try {
    const registry = input.registry ?? EMPTY_REGISTRY
    const permissions = { check: async () => true }      // single-user / trusted orb
    const hooks = {
      runPreToolUse: async () => ({ allow: true }),
      runPostToolUse: async (_n: string, r: any) => r,
      runStop: async () => true,
    }
    const streaming = input.stream ?? !!input.onText
    const settings = {
      stream: streaming,
      maxContextTokens: Number(process.env.ORB2_MAX_CONTEXT_TOKENS || 120000),
      maxTurns: input.maxTurns ?? 24,
      systemPromptOverride: input.systemPrompt,
    }

    const loop: any = createAgentLoop({ model, tools: registry, permissions, settings, hooks })
    if (input.previousMessages?.length && loop.state) {
      loop.state.messages = normalizeHistory(input.previousMessages)
    }

    // In streaming mode the engine emits both incremental `stream_event`
    // deltas AND a final authoritative `assistant` block per text segment.
    // We accumulate fullText from `assistant` (authoritative, no double
    // count) and use `stream_event` purely to drive the live onText UX.
    // In non-streaming mode there are no deltas, so `assistant` also drives
    // onText so callers still receive the text once.
    let fullText = ''
    const toolCalls: string[] = []
    for await (const ev of loop.run(input.message) as AsyncIterable<any>) {
      if (ev.type === 'stream_event' && ev.text) { input.onText?.(ev.text) }
      else if (ev.type === 'assistant' && typeof ev.content === 'string') {
        fullText += ev.content
        if (!streaming) input.onText?.(ev.content)
      }
      else if (ev.type === 'tool_progress' && ev.tool) { toolCalls.push(ev.tool); input.onToolStart?.({ tool: ev.tool }) }
      else if (ev.type === 'result' && ev.tool) {
        const out = typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result ?? '')
        input.onToolResult?.({ tool: ev.tool, output: out })
      }
      else if (ev.type === 'thinking' && ev.text) { input.onThinking?.({ text: ev.text }) }
      else if (ev.type === 'error' && !fullText) fullText = `(engine error: ${ev.message})`
    }
    const usage = loop.state?.tokenUsage ?? { input: 0, output: 0 }
    return {
      fullText: fullText.trim(),
      finalMessages: loop.state?.messages ?? [],
      toolCalls,
      promptTokens: usage.input ?? 0,
      completionTokens: usage.output ?? 0,
    }
  } finally {
    if (savedBase === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = savedBase
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedKey
  }
}
