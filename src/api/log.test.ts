import { describe, test, expect } from 'bun:test'
import { redactHeaders, SENSITIVE_HEADERS } from './log.ts'

describe('redactHeaders', () => {
  test('redacts Authorization, Cookie, X-API-Key', () => {
    const h = new Headers()
    h.set('Authorization', 'Bearer rak00n_secret')
    h.set('Cookie', 'session=xxxx')
    h.set('X-API-Key', 'key123')
    h.set('Content-Type', 'application/json')
    const r = redactHeaders(h)
    expect(r['authorization']).toBe('[REDACTED]')
    expect(r['cookie']).toBe('[REDACTED]')
    expect(r['x-api-key']).toBe('[REDACTED]')
    expect(r['content-type']).toBe('application/json')
  })

  test('accepts plain record', () => {
    const r = redactHeaders({
      Authorization: 'Bearer x',
      'X-Foundry-Token': 't',
      Accept: '*/*',
    })
    expect(r['authorization']).toBe('[REDACTED]')
    expect(r['x-foundry-token']).toBe('[REDACTED]')
    expect(r['accept']).toBe('*/*')
  })

  test('lowercases all keys', () => {
    const r = redactHeaders({ 'X-Custom': 'v' })
    expect(r['x-custom']).toBe('v')
    expect(r['X-Custom']).toBeUndefined()
  })

  test('SENSITIVE_HEADERS includes the expected names', () => {
    for (const name of ['authorization', 'cookie', 'x-api-key', 'set-cookie']) {
      expect(SENSITIVE_HEADERS.has(name)).toBe(true)
    }
  })

  test('no plaintext token from Authorization survives in serialization', () => {
    const r = redactHeaders({ Authorization: 'Bearer rak00n_aaaaaaaa' })
    const json = JSON.stringify(r)
    expect(json).not.toContain('rak00n_aaaaaaaa')
  })
})
