import { describe, test, expect } from 'bun:test'
import { z } from 'zod'
import { parseBody } from './parseBody.ts'
import { CreateKeyRequest } from './keys.ts'
import { SandboxRunRequest } from './sandbox.ts'
import { ToolInvokeRequest } from './tools.ts'

function makeReq(body: unknown): Request {
  return new Request('http://x/y', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('parseBody', () => {
  test('returns ok+data on valid JSON', async () => {
    const schema = z.object({ a: z.number() })
    const r = await parseBody(makeReq({ a: 1 }), schema)
    expect(r instanceof Response).toBe(false)
    if (!(r instanceof Response)) expect(r.data.a).toBe(1)
  })

  test('returns 400 INVALID_JSON when body is not JSON', async () => {
    const schema = z.object({ a: z.number() })
    const r = await parseBody(makeReq('not-json-{'), schema)
    expect(r instanceof Response).toBe(true)
    if (r instanceof Response) {
      expect(r.status).toBe(400)
      const body = await r.json()
      expect(body.code).toBe('INVALID_JSON')
    }
  })

  test('returns 400 VALIDATION_FAILED with issues array', async () => {
    const schema = z.object({ a: z.number(), b: z.string() })
    const r = await parseBody(makeReq({ a: 'oops' }), schema)
    expect(r instanceof Response).toBe(true)
    if (r instanceof Response) {
      const body = await r.json()
      expect(body.code).toBe('VALIDATION_FAILED')
      expect(Array.isArray(body.issues)).toBe(true)
      expect(body.issues.length).toBeGreaterThan(0)
    }
  })
})

describe('CreateKeyRequest schema', () => {
  test('accepts minimal valid body', () => {
    const r = CreateKeyRequest.safeParse({ name: 'demo' })
    expect(r.success).toBe(true)
  })
  test('rejects empty name', () => {
    expect(CreateKeyRequest.safeParse({ name: '' }).success).toBe(false)
    expect(CreateKeyRequest.safeParse({}).success).toBe(false)
  })
  test('rejects malformed email', () => {
    expect(CreateKeyRequest.safeParse({ name: 'x', owner_email: 'not-an-email' }).success).toBe(false)
  })
  test('rejects oversize allowed_tools', () => {
    const big = Array.from({ length: 65 }, (_, i) => `t${i}`)
    expect(CreateKeyRequest.safeParse({ name: 'x', allowed_tools: big }).success).toBe(false)
  })
  test('rejects allowed_tools with bad chars', () => {
    expect(CreateKeyRequest.safeParse({ name: 'x', allowed_tools: ['has space'] }).success).toBe(false)
  })
})

describe('SandboxRunRequest schema', () => {
  test('accepts python3 + code', () => {
    expect(SandboxRunRequest.safeParse({ code: 'print(1)' }).success).toBe(true)
  })
  test('rejects unsupported language', () => {
    expect(SandboxRunRequest.safeParse({ language: 'ruby', code: 'puts 1' }).success).toBe(false)
  })
  test('rejects code over 256KB', () => {
    const big = 'a'.repeat(256 * 1024 + 1)
    expect(SandboxRunRequest.safeParse({ code: big }).success).toBe(false)
  })
  test('rejects timeout outside bounds', () => {
    expect(SandboxRunRequest.safeParse({ code: 'x', timeoutMs: 1 }).success).toBe(false)
    expect(SandboxRunRequest.safeParse({ code: 'x', timeoutMs: 60_001 }).success).toBe(false)
  })
})

describe('ToolInvokeRequest schema', () => {
  test('accepts arguments object', () => {
    expect(ToolInvokeRequest.safeParse({ arguments: {} }).success).toBe(true)
    expect(ToolInvokeRequest.safeParse({ arguments: { x: 1 } }).success).toBe(true)
  })
  test('rejects missing arguments', () => {
    expect(ToolInvokeRequest.safeParse({}).success).toBe(false)
  })
  test('rejects oversize working_directory', () => {
    expect(ToolInvokeRequest.safeParse({ arguments: {}, working_directory: 'x'.repeat(513) }).success).toBe(false)
  })
})
