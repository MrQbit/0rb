/**
 * Native Anthropic Messages API support for the agent loop.
 *
 * The loop keeps its history in OpenAI chat-completions shape (that's what
 * every other backend speaks); this adapter translates at the wire: tool
 * definitions (parameters → input_schema), assistant tool_calls → tool_use
 * blocks, role:'tool' results → user tool_result blocks, data-URI images →
 * base64 image blocks — and parses Anthropic's SSE back into the loop's
 * {content, toolCalls, usage} shape so nothing downstream changes.
 *
 * Activates when the configured endpoint is api.anthropic.com, or when the
 * key is an sk-ant- key with no endpoint set.
 */

export interface ChatResult { content: string; toolCalls: any[]; usage: { input: number; output: number } }

export function isAnthropic(baseUrl?: string, apiKey?: string): boolean {
  const base = (baseUrl ?? process.env.OPENAI_BASE_URL ?? '').trim()
  const key = (apiKey ?? process.env.OPENAI_API_KEY ?? '').trim()
  if (!base) return key.startsWith('sk-ant-')
  try { return new URL(base).hostname.toLowerCase() === 'api.anthropic.com' } catch { return false }
}

export function anthropicEndpoint(): string {
  return 'https://api.anthropic.com/v1/messages'
}

export function anthropicHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': process.env.OPENAI_API_KEY || '',
    'anthropic-version': '2023-06-01',
  }
}

/** OpenAI function-tool defs → Anthropic tool defs. */
export function toAnthropicTools(fnTools: any[]): any[] {
  return (fnTools || []).map(t => ({
    name: t.function?.name ?? t.name,
    description: t.function?.description ?? t.description ?? '',
    input_schema: t.function?.parameters ?? t.input_schema ?? { type: 'object', properties: {} },
  }))
}

/** One OpenAI content part → one Anthropic content block. */
function toBlock(part: any): any {
  if (typeof part === 'string') return { type: 'text', text: part }
  if (part?.type === 'image_url') {
    const url = String(part.image_url?.url || '')
    const m = url.match(/^data:([^;]+);base64,(.+)$/s)
    if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }
    return { type: 'text', text: `[image: ${url.slice(0, 100)}]` } // non-data URLs aren't sent upstream
  }
  if (part?.type === 'text') return { type: 'text', text: String(part.text ?? '') }
  return { type: 'text', text: JSON.stringify(part) }
}

/**
 * OpenAI-shaped history → Anthropic messages. Groups consecutive tool
 * results into one user turn (required: tool_result must directly follow its
 * tool_use), skips empty assistant stubs, and merges consecutive same-role
 * messages (the API wants alternating roles).
 */
export function toAnthropicMessages(history: any[]): any[] {
  const out: any[] = []
  const push = (role: 'user' | 'assistant', blocks: any[]) => {
    if (!blocks.length) return
    const last = out[out.length - 1]
    if (last && last.role === role) last.content.push(...blocks)
    else out.push({ role, content: blocks })
  }
  for (const m of history || []) {
    if (m.role === 'user') {
      const blocks = Array.isArray(m.content) ? m.content.map(toBlock) : [{ type: 'text', text: String(m.content ?? '') }]
      push('user', blocks.filter((b: any) => b.type !== 'text' || b.text !== ''))
    } else if (m.role === 'assistant') {
      const blocks: any[] = []
      const text = typeof m.content === 'string' ? m.content : ''
      if (text) blocks.push({ type: 'text', text })
      for (const tc of m.tool_calls || []) {
        let input: any = {}
        try { input = JSON.parse(tc.function?.arguments || '{}') } catch { input = {} }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name ?? '', input })
      }
      push('assistant', blocks)
    } else if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content ?? '') }])
    }
    // role:'system' never appears in loop history — the system prompt is passed top-level.
  }
  return out
}

export function buildAnthropicBody(opts: { model: string; system: string; history: any[]; fnTools: any[]; stream: boolean }): any {
  const tools = toAnthropicTools(opts.fnTools)
  return {
    model: opts.model,
    max_tokens: Number(process.env.ORB2_MAX_OUTPUT_TOKENS) || 8192,
    system: opts.system,
    messages: toAnthropicMessages(opts.history),
    ...(tools.length > 0 && { tools }),
    stream: opts.stream,
  }
}

/** Non-streaming response → loop shape. */
export function parseAnthropicResponse(data: any): ChatResult {
  let content = ''
  const toolCalls: any[] = []
  for (const block of data?.content || []) {
    if (block.type === 'text') content += block.text || ''
    if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } })
    }
  }
  return {
    content, toolCalls,
    usage: { input: data?.usage?.input_tokens || 0, output: data?.usage?.output_tokens || 0 },
  }
}

/** Anthropic SSE stream → yields text deltas, returns the assembled result. */
export async function* streamAnthropic(res: Response): AsyncGenerator<string, ChatResult> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  const usage = { input: 0, output: 0 }
  // index → partially-assembled tool_use block
  const pending = new Map<number, { id: string; name: string; args: string }>()

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      let evt: any
      try { evt = JSON.parse(trimmed.slice(5).trim()) } catch { continue }
      switch (evt.type) {
        case 'message_start':
          usage.input = evt.message?.usage?.input_tokens || 0
          break
        case 'content_block_start':
          if (evt.content_block?.type === 'tool_use') {
            pending.set(evt.index, { id: evt.content_block.id, name: evt.content_block.name, args: '' })
          }
          break
        case 'content_block_delta':
          if (evt.delta?.type === 'text_delta' && evt.delta.text) { content += evt.delta.text; yield evt.delta.text }
          else if (evt.delta?.type === 'input_json_delta') {
            const p = pending.get(evt.index)
            if (p) p.args += evt.delta.partial_json || ''
          }
          break
        case 'message_delta':
          if (evt.usage?.output_tokens != null) usage.output = evt.usage.output_tokens
          break
      }
    }
  }
  const toolCalls = [...pending.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => ({
    id: p.id, type: 'function', function: { name: p.name, arguments: p.args || '{}' },
  }))
  return { content, toolCalls, usage }
}
