import { describe, test, expect } from 'bun:test'
import { validateSpec, catalogVersion, catalogPromptBlock, attentionOf, CATALOG } from './catalog.ts'

describe('widget catalog', () => {
  test('every catalog type has a tier and refresh mode', () => {
    for (const [t, e] of Object.entries(CATALOG)) {
      expect(['ambient', 'glance', 'notify', 'interrupt']).toContain(e.attention)
      expect(['live', 'snapshot']).toContain(e.refresh)
      expect(typeof e.hint).toBe('string')
    }
    expect(Object.keys(CATALOG).length).toBeGreaterThanOrEqual(43)
  })

  test('validation strips unknown fields, keeps declared + passthrough', () => {
    const v = validateSpec({ id: 'x', type: 'note', title: 'T', text: 'hi', evil: '<script>', onclick: 'x' })
    expect(v.ok).toBe(true)
    expect(v.spec.text).toBe('hi')
    expect(v.spec.evil).toBeUndefined()
    expect(v.stripped.sort()).toEqual(['evil', 'onclick'])
  })

  test('unknown types rejected unless a plugin claims them', () => {
    expect(validateSpec({ type: 'nope' }).ok).toBe(false)
    expect(validateSpec({ type: 'nope' }, t => t === 'nope').ok).toBe(true)
  })

  test('attention can be lowered, never raised', () => {
    const lower = validateSpec({ type: 'approval', attention: 'glance', approval_id: 'a', summary: 's' })
    expect(lower.spec.attention).toBe('glance')          // notify → glance ok
    const raise = validateSpec({ type: 'note', attention: 'interrupt', text: 'x' })
    expect(raise.spec.attention).toBe('glance')          // glance stays glance
    expect(attentionOf('housemode')).toBe('ambient')
  })

  test('version is stable and the prompt block stays lean', () => {
    expect(catalogVersion()).toBe(catalogVersion())
    const block = catalogPromptBlock()
    expect(block).toContain(`v${catalogVersion()}`)
    expect(block.length).toBeLessThan(4000)              // ~<1k tokens
  })
})
