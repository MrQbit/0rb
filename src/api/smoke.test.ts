/**
 * HTTP-layer smoke tests for the rak00n API.
 * Requires a running server at RAK00N_SMOKE_URL (default: http://localhost:9080).
 * No LLM calls — only static/catalog endpoints.
 */
import { describe, it, expect } from 'bun:test'

const BASE = process.env.RAK00N_SMOKE_URL || 'http://localhost:9080'

async function get(path: string) {
  return fetch(`${BASE}${path}`)
}

async function post(path: string, body: unknown) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('HTTP smoke tests', () => {
  it('GET /healthz → 200 {ok:true}', async () => {
    const res = await get('/healthz')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  it('GET /readyz → 200 or 503 with ok field', async () => {
    const res = await get('/readyz')
    expect([200, 503]).toContain(res.status)
    const body = await res.json()
    expect(typeof body.ok).toBe('boolean')
  })

  it('GET /v1/info → 200 with agent_id, version, llm', async () => {
    const res = await get('/v1/info')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.agent_id).toBe('string')
    expect(typeof body.version).toBe('string')
    expect(body.llm).toBeDefined()
    expect(typeof body.single_user).toBe('boolean')
  })

  it('GET /v1/models → 200 with at least one model', async () => {
    const res = await get('/v1/models')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.models)).toBe(true)
    expect(body.models.length).toBeGreaterThanOrEqual(1)
  })

  it('GET /v1/tools → 200 with at least 10 tools', async () => {
    const res = await get('/v1/tools')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.tools)).toBe(true)
    expect(body.tools.length).toBeGreaterThanOrEqual(10)
  })

  it('GET /v1/skills → 200 with skills array', async () => {
    const res = await get('/v1/skills')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.skills)).toBe(true)
  })

  it('GET /v1/skills → no fabric skills', async () => {
    const res = await get('/v1/skills')
    const body = await res.json()
    const names: string[] = body.skills.map((s: any) => s.name)
    expect(names.every((n: string) => !n.startsWith('fabric'))).toBe(true)
  })

  it('GET /v1/info → default_mcp_servers is empty (no eyqmcp)', async () => {
    const res = await get('/v1/info')
    const body = await res.json()
    expect(Array.isArray(body.default_mcp_servers)).toBe(true)
    const eyq = body.default_mcp_servers.find((s: any) => s.name === 'eyq')
    expect(eyq).toBeUndefined()
  })

  it('POST /v1/chat missing body → 400', async () => {
    const res = await fetch(`${BASE}/v1/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    })
    expect(res.status).toBe(400)
  })

  it('POST /v1/sandbox/run python → stdout 1', async () => {
    const res = await post('/v1/sandbox/run', { language: 'python3', code: 'print(1)' })
    if (res.status === 404 || res.status === 503) {
      // Sandbox not enabled in this deployment — skip gracefully
      return
    }
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.stdout?.trim()).toBe('1')
  })
})
