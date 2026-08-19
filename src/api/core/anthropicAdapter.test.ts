import { describe, test, expect, afterEach } from 'bun:test'
import {
  isAnthropic, toAnthropicTools, toAnthropicMessages, buildAnthropicBody,
  parseAnthropicResponse, streamAnthropic,
} from './anthropicAdapter.ts'

const ENV_KEYS = ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'ORB2_MAX_OUTPUT_TOKENS']
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k] } })

describe('detection', () => {
  test('matches api.anthropic.com endpoints, with or without a path', () => {
    expect(isAnthropic('https://api.anthropic.com', 'x')).toBe(true)
    expect(isAnthropic('https://api.anthropic.com/v1', 'x')).toBe(true)
    expect(isAnthropic('https://api.openai.com/v1', 'sk-abc')).toBe(false)
    expect(isAnthropic('http://vllm:8888/v1', 'local')).toBe(false)
  })
  test('sk-ant- key with no endpoint means Anthropic; with a non-Anthropic endpoint it does not', () => {
    expect(isAnthropic('', 'sk-ant-abc123')).toBe(true)
    expect(isAnthropic('http://vllm:8888/v1', 'sk-ant-abc123')).toBe(false)
  })
  test('does not match a lookalike host', () => {
    expect(isAnthropic('https://api.anthropic.com.evil.example', 'x')).toBe(false)
  })
})

describe('tool definitions', () => {
  test('OpenAI function tools → name/description/input_schema', () => {
    const [t] = toAnthropicTools([{
      type: 'function',
      function: { name: 'Home', description: 'Control the home.', parameters: { type: 'object', properties: { op: { type: 'string' } } } },
    }])
    expect(t.name).toBe('Home')
    expect(t.description).toBe('Control the home.')
    expect(t.input_schema.properties.op.type).toBe('string')
    expect(t.function).toBeUndefined()
  })
})

describe('message translation', () => {
  test('assistant tool_calls become tool_use blocks; tool results group into one user turn', () => {
    const msgs = toAnthropicMessages([
      { role: 'user', content: 'turn on the lights and the fan' },
      { role: 'assistant', content: 'On it.', tool_calls: [
        { id: 'toolu_1', function: { name: 'Home', arguments: '{"op":"lights"}' } },
        { id: 'toolu_2', function: { name: 'Home', arguments: '{"op":"fan"}' } },
      ] },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'lights on' },
      { role: 'tool', tool_call_id: 'toolu_2', content: 'fan on' },
    ])
    expect(msgs).toHaveLength(3)
    expect(msgs[1]!.role).toBe('assistant')
    expect(msgs[1]!.content.map((b: any) => b.type)).toEqual(['text', 'tool_use', 'tool_use'])
    expect(msgs[1]!.content[1].input).toEqual({ op: 'lights' })
    // both results land in ONE user message, directly after the tool_use turn
    expect(msgs[2]!.role).toBe('user')
    expect(msgs[2]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'lights on' },
      { type: 'tool_result', tool_use_id: 'toolu_2', content: 'fan on' },
    ])
  })

  test('empty assistant stubs are dropped and roles stay alternating', () => {
    const msgs = toAnthropicMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '' },
      { role: 'user', content: '[system: continue]' },
    ])
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.role).toBe('user')
    expect(msgs[0]!.content).toHaveLength(2)
  })

  test('data-URI images become base64 image blocks', () => {
    const msgs = toAnthropicMessages([
      { role: 'user', content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/AAA=' } },
      ] },
    ])
    const img = msgs[0]!.content[1]
    expect(img.type).toBe('image')
    expect(img.source).toEqual({ type: 'base64', media_type: 'image/jpeg', data: '/9j/AAA=' })
  })
})

describe('request body', () => {
  test('system is top-level, max_tokens defaults, tools included only when present', () => {
    delete process.env.ORB2_MAX_OUTPUT_TOKENS
    const body = buildAnthropicBody({ model: 'claude-sonnet-4-6', system: 'be brief', history: [{ role: 'user', content: 'hi' }], fnTools: [], stream: true })
    expect(body.system).toBe('be brief')
    expect(body.model).toBe('claude-sonnet-4-6')
    expect(body.max_tokens).toBe(8192)
    expect(body.tools).toBeUndefined()
    expect(body.stream).toBe(true)
  })
})

describe('response parsing', () => {
  test('non-streaming: text + tool_use blocks → loop shape', () => {
    const out = parseAnthropicResponse({
      content: [
        { type: 'text', text: 'Checking. ' },
        { type: 'tool_use', id: 'toolu_9', name: 'Weather', input: { place: 'home' } },
      ],
      usage: { input_tokens: 12, output_tokens: 34 },
    })
    expect(out.content).toBe('Checking. ')
    expect(out.toolCalls).toEqual([{ id: 'toolu_9', type: 'function', function: { name: 'Weather', arguments: '{"place":"home"}' } }])
    expect(out.usage).toEqual({ input: 12, output: 34 })
  })

  test('streaming: yields text deltas, assembles tool calls from json deltas, captures usage', async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":7}}}',
      '',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"One sec"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"…"}}',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_5","name":"Timer"}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"minutes\\""}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":":9}"}}',
      'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":21}}',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n')
    const res = new Response(sse)
    const it = streamAnthropic(res)
    const chunks: string[] = []
    let step = await it.next()
    while (!step.done) { chunks.push(step.value as string); step = await it.next() }
    expect(chunks.join('')).toBe('One sec…')
    const out = step.value
    expect(out.content).toBe('One sec…')
    expect(out.toolCalls).toEqual([{ id: 'toolu_5', type: 'function', function: { name: 'Timer', arguments: '{"minutes":9}' } }])
    expect(out.usage).toEqual({ input: 7, output: 21 })
  })
})
