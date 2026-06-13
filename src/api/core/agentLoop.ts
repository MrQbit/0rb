/**
 * Orb agent core — the tool-calling loop.
 *
 * Purpose-built for OpenAI-compatible chat-completions endpoints, which is what
 * every backend Orb talks to speaks: a local Ollama/vLLM server, or a hosted
 * provider through OpenRouter. One turn = call the model, run any tools it asks
 * for, feed the results back, repeat until it answers. Text and tool activity
 * stream out as events so the API/voice layers can react live.
 *
 * The loop is intentionally small and provider-agnostic at the HTTP level; the
 * caller sets OPENAI_BASE_URL / OPENAI_API_KEY / model for the turn.
 */

export interface LoopToolDef { name: string; description: string; input_schema: any }
export interface LoopTools {
  list: () => LoopToolDef[]
  call: (name: string, input: any) => Promise<string>
  has?: (name: string) => boolean
  get?: (name: string) => any
}
export interface LoopPermissions { check?: (name: string, input: any) => Promise<boolean> | boolean }
export interface LoopHooks {
  runPreToolUse?: (name: string, input: any) => Promise<{ allow: boolean; message?: string }>
  runPostToolUse?: (name: string, result: string) => Promise<string>
  runStop?: () => Promise<boolean>
}
export interface LoopSettings {
  stream?: boolean
  maxTurns?: number
  systemPromptOverride?: string
  maxContextTokens?: number
}
export interface LoopState {
  messages: any[]
  systemPrompt: string
  model: string
  turnCount: number
  tokenUsage: { input: number; output: number }
}

interface CreateLoopArgs {
  model: string
  tools: LoopTools
  permissions?: LoopPermissions
  settings?: LoopSettings
  hooks?: LoopHooks
}

const DEFAULT_SYSTEM = 'You are a helpful assistant.'

/** Map the tool registry into OpenAI function-tool definitions. */
function toFunctionTools(defs: LoopToolDef[]): any[] {
  return defs.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema ?? { type: 'object', properties: {} },
    },
  }))
}

function endpoint(): string {
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')
  return `${base}/chat/completions`
}

function buildBody(state: LoopState, toolDefs: any[], stream: boolean): any {
  const messages = [{ role: 'system', content: state.systemPrompt }, ...state.messages]
  return {
    model: state.model,
    messages,
    ...(toolDefs.length > 0 && { tools: toolDefs }),
    stream,
    ...(stream && { stream_options: { include_usage: true } }),
    // vLLM/Qwen reasoning toggle (ignored by OpenAI/OpenRouter).
    ...(process.env.ORB2_DISABLE_THINKING === '1' && {
      chat_template_kwargs: { enable_thinking: false },
    }),
  }
}

/** Accumulate streamed tool-call fragments (delta.tool_calls) by index. */
function mergeToolCallDeltas(acc: any[], deltas: any[]): void {
  for (const d of deltas) {
    const i = d.index ?? 0
    if (!acc[i]) acc[i] = { id: d.id || '', type: 'function', function: { name: '', arguments: '' } }
    if (d.id) acc[i].id = d.id
    if (d.function?.name) acc[i].function.name += d.function.name
    if (d.function?.arguments) acc[i].function.arguments += d.function.arguments
  }
}

interface StreamResult { content: string; toolCalls: any[]; usage: { input: number; output: number } }

/** Read an SSE chat-completions stream as an async generator: yields each text
 *  delta live, then returns the assembled message (content + tool_calls + usage). */
async function* streamChat(res: Response): AsyncGenerator<string, StreamResult> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  const toolCalls: any[] = []
  let usage = { input: 0, output: 0 }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') continue
      let evt: any
      try { evt = JSON.parse(payload) } catch { continue }
      if (evt.usage) {
        usage = { input: evt.usage.prompt_tokens || 0, output: evt.usage.completion_tokens || 0 }
      }
      const delta = evt.choices?.[0]?.delta
      if (!delta) continue
      if (delta.content) { content += delta.content; yield delta.content }
      if (delta.tool_calls) mergeToolCallDeltas(toolCalls, delta.tool_calls)
    }
  }
  return { content, toolCalls: toolCalls.filter(Boolean), usage }
}

export function createAgentLoop({ model, tools, permissions, settings = {}, hooks = {} }: CreateLoopArgs) {
  const state: LoopState = {
    messages: [],
    systemPrompt: settings.systemPromptOverride?.trim() || DEFAULT_SYSTEM,
    model,
    turnCount: 0,
    tokenUsage: { input: 0, output: 0 },
  }
  const maxTurns = settings.maxTurns ?? 24
  const stream = settings.stream !== false

  async function* run(userMessage: string | null): AsyncGenerator<any> {
    if (userMessage != null) state.messages.push({ role: 'user', content: userMessage })

    const toolDefs = toFunctionTools(tools.list?.() ?? [])

    for (let turn = 0; turn < maxTurns; turn++) {
      state.turnCount++
      yield { type: 'stream_request_start', turn: state.turnCount }

      let text = ''
      let toolCalls: any[] = []
      try {
        const res = await fetch(endpoint(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.OPENAI_API_KEY || 'local'}`,
          },
          body: JSON.stringify(buildBody(state, toolDefs, stream)),
        })
        if (!res.ok) {
          const err = await res.text().catch(() => '')
          yield { type: 'error', message: `model API error ${res.status}: ${err.slice(0, 300)}` }
          return
        }

        if (stream) {
          const it = streamChat(res)
          let step = await it.next()
          while (!step.done) {
            yield { type: 'stream_event', text: step.value }
            step = await it.next()
          }
          const out = step.value as StreamResult
          text = out.content
          toolCalls = out.toolCalls
          state.tokenUsage.input += out.usage.input
          state.tokenUsage.output += out.usage.output
        } else {
          const data: any = await res.json()
          const msg = data.choices?.[0]?.message ?? {}
          text = msg.content || ''
          toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
          state.tokenUsage.input += data.usage?.prompt_tokens || 0
          state.tokenUsage.output += data.usage?.completion_tokens || 0
        }
      } catch (err) {
        yield { type: 'error', message: `model request failed: ${(err as Error).message}` }
        return
      }

      // Record the assistant message (with any tool calls) for history.
      const assistantMsg: any = { role: 'assistant', content: text || '' }
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls
      state.messages.push(assistantMsg)
      if (text) yield { type: 'assistant', content: text }

      if (toolCalls.length === 0) {
        if (hooks.runStop && !(await hooks.runStop())) {
          state.messages.push({ role: 'user', content: '[system: continue]' })
          continue
        }
        yield { type: 'stop', reason: 'end_turn' }
        return
      }

      // Execute each requested tool, append results, then loop.
      for (const tc of toolCalls) {
        const name = tc.function?.name ?? ''
        let input: any = {}
        try { input = JSON.parse(tc.function?.arguments || '{}') } catch { input = {} }

        yield { type: 'tool_progress', tool: name, status: 'running' }

        if (hooks.runPreToolUse) {
          const pre = await hooks.runPreToolUse(name, input)
          if (!pre.allow) {
            const blocked = `Blocked: ${pre.message ?? 'not permitted'}`
            state.messages.push({ role: 'tool', tool_call_id: tc.id, content: blocked })
            yield { type: 'result', tool: name, result: blocked }
            continue
          }
        }
        if (permissions?.check && !(await permissions.check(name, input))) {
          const denied = 'Permission denied'
          state.messages.push({ role: 'tool', tool_call_id: tc.id, content: denied })
          yield { type: 'result', tool: name, result: denied }
          continue
        }

        let result = ''
        try { result = await tools.call(name, input) } catch (e) { result = `Tool error: ${(e as Error).message}` }
        if (hooks.runPostToolUse) result = await hooks.runPostToolUse(name, result)

        state.messages.push({ role: 'tool', tool_call_id: tc.id, content: result })
        yield { type: 'result', tool: name, result }
      }
    }

    yield { type: 'error', message: `max turns (${maxTurns}) reached` }
    yield { type: 'stop', reason: 'max_turns' }
  }

  return { run, state }
}
