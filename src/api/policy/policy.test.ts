import { describe, test, expect } from 'bun:test'
import {
  baseImpact, actionKey, effectiveImpact, grantAutonomy, revokeAutonomy, listAutonomy,
  recordReceipt, listReceipts, resolveApproval, requestApproval,
} from './policy.ts'

function memStore() {
  const kv = new Map<string, string>()
  return {
    async getKv(k: string) { return kv.get(k) ?? null },
    async putKv(k: string, v: string) { kv.set(k, v) },
    async delKv(k: string) { kv.delete(k) },
  } as any
}

describe('impact classification', () => {
  test('reads are silent, controls reversible, locks/secure/print/automations confirm', () => {
    expect(baseImpact('Home', { op: 'list' })).toBe('read')
    expect(baseImpact('Home', { op: 'control', action: 'on', query: 'kitchen' })).toBe('reversible')
    expect(baseImpact('Home', { op: 'control', action: 'unlock', query: 'front door' })).toBe('confirm')
    expect(baseImpact('Home', { op: 'mode', mode: 'away', secure: true })).toBe('confirm')
    expect(baseImpact('Home', { op: 'mode', mode: 'away' })).toBe('reversible')
    expect(baseImpact('Print', { op: 'print', text: 'x' })).toBe('confirm')
    expect(baseImpact('Print', { op: 'status' })).toBe('read')
    expect(baseImpact('HomeAdmin', { op: 'automate' })).toBe('confirm')
    expect(baseImpact('AirPlay', { op: 'say', text: 'hi' })).toBe('reversible')
    expect(baseImpact('WebSearch', { q: 'x' })).toBe('read')
  })

  test('action keys group what consent applies to', () => {
    expect(actionKey('Home', { op: 'control', action: 'lock', query: 'front' })).toBe('Home:lock')
    expect(actionKey('Home', { op: 'control', action: 'unlock' })).toBe('Home:lock')
    expect(actionKey('Home', { op: 'mode', mode: 'away', secure: true })).toBe('Home:secure')
    expect(actionKey('Print', { op: 'print' })).toBe('Print:print')
  })
})

describe('earned autonomy', () => {
  test('grant converts confirm to reversible for that user only', async () => {
    const store = memStore()
    const args = { op: 'control', action: 'unlock', query: 'front door' }
    expect(await effectiveImpact(store, 'martin', 'Home', args)).toBe('confirm')
    await grantAutonomy(store, 'martin', actionKey('Home', args))
    expect(await effectiveImpact(store, 'martin', 'Home', args)).toBe('reversible')
    expect(await effectiveImpact(store, 'ana', 'Home', args)).toBe('confirm')
    expect(await listAutonomy(store, 'martin')).toEqual(['Home:lock'])
    await revokeAutonomy(store, 'martin', 'Home:lock')
    expect(await effectiveImpact(store, 'martin', 'Home', args)).toBe('confirm')
  })
})

describe('undo', () => {
  test('home-control inverse calls HA and marks the receipt undone', async () => {
    const store = memStore()
    const r = await recordReceipt(store, {
      user: 'martin', tool: 'Home', key: 'Home:control', summary: 'Turn off the TV',
      inverse: { kind: 'home-control', entity_id: 'media_player.tv', action: 'on' },
    })
    const REAL = globalThis.fetch
    let called = ''
    globalThis.fetch = (async (url: any, init: any) => {
      called = `${init?.method || 'GET'} ${url}`
      return new Response('[]', { status: 200 })
    }) as any
    try {
      const { undoReceipt } = await import('./policy.ts')
      const done = await undoReceipt(store, r.id)
      expect(done).toContain('Undid')
      expect(called).toContain('turn_on')
      const list = await listReceipts(store, 5)
      expect(list.find(x => x.id === r.id)!.undone).toBe(true)
      expect(list[0]!.summary).toContain('Undid')
      // second undo refuses
      expect(await undoReceipt(store, r.id)).toBeNull()
    } finally { globalThis.fetch = REAL }
  })

  test('display ops are reads (no receipts)', () => {
    expect(baseImpact('Home', { op: 'lights' })).toBe('read')
    expect(baseImpact('Home', { op: 'security' })).toBe('read')
    expect(baseImpact('Home', { op: 'media' })).toBe('read')
  })
})

describe('receipts ledger', () => {
  test('records, lists newest-first, caps size', async () => {
    const store = memStore()
    for (let i = 0; i < 5; i++) {
      await recordReceipt(store, { user: 'martin', tool: 'Home', key: 'Home:control', summary: `act ${i}` })
    }
    const list = await listReceipts(store, 3)
    expect(list).toHaveLength(3)
    expect(list[0]!.summary).toBe('act 4')
    expect(list[0]!.id).toMatch(/^r-/)
  })
})

describe('approvals', () => {
  test('resolve unblocks a pending request; unknown id refused; count recorded', async () => {
    const store = memStore()
    const { onWidget } = await import('../widgets/bus.js')
    let captured = ''
    const off = onWidget('sess-2', (spec: any) => { if (spec.type === 'approval' && !spec.resolved) captured = spec.approval_id })
    const p = requestApproval(store, 'sess-2', 'ana', 'Print', { op: 'print' }, 'Print a page', 'gated')
    await new Promise(r => setTimeout(r, 20))
    expect(captured).toMatch(/^ap-/)
    expect(resolveApproval('ap-nope', true)).toBe(false)
    expect(resolveApproval(captured, true)).toBe(true)
    const r = await p
    expect(r.approved).toBe(true)
    if (typeof off === 'function') off()
    expect(await store.getKv('policy:approvals:ana|Print:print')).toBe('1')
  }, 10_000)
})
