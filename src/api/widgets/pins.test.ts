import { describe, test, expect } from 'bun:test'
import { pinWidget, unpinWidget, listPins, updatePinned, revertPinned, composeBoard, pinnedIds } from './pins.ts'

function memStore() {
  const kv = new Map<string, string>()
  return {
    async getKv(k: string) { return kv.get(k) ?? null },
    async putKv(k: string, v: string) { kv.set(k, v) },
    async delKv(k: string) { kv.delete(k) },
  } as any
}

describe('pinned widgets', () => {
  test('pin, list per member, unpin', async () => {
    const s = memStore()
    expect(await pinWidget(s, 'martin', { id: 'wx', type: 'weather', title: 'Weather' })).toBe(true)
    expect(await pinWidget(s, 'martin', { type: 'weather' })).toBe(false)      // no id
    expect((await listPins(s, 'martin')).map(p => p.id)).toEqual(['wx'])
    expect(await listPins(s, 'ana')).toEqual([])                               // per-member
    expect(await pinnedIds(s, 'martin')).toEqual(['wx'])
    expect(await unpinWidget(s, 'martin', 'wx')).toBe(true)
    expect(await listPins(s, 'martin')).toEqual([])
  })

  test('edit-by-diff keeps history and reverts', async () => {
    const s = memStore()
    await pinWidget(s, 'martin', { id: 'wx', type: 'weather', title: 'Weather', unit: 'F' })
    expect(await updatePinned(s, 'martin', { id: 'wx', type: 'weather', title: 'Weather', unit: 'F', current: { humidity: 40 } })).toBe(true)
    expect((await listPins(s, 'martin'))[0].current.humidity).toBe(40)
    const reverted = await revertPinned(s, 'martin', 'wx')
    expect(reverted.current).toBeUndefined()
    expect(await updatePinned(s, 'martin', { id: 'nope', type: 'note' })).toBe(false)  // not pinned
  })

  test('board: pins first, contextual autos by time, tier-filtered', async () => {
    const s = memStore()
    await pinWidget(s, 'martin', { id: 'wx', type: 'weather', title: 'Weather' })
    await pinWidget(s, 'martin', { id: 'ap', type: 'approval', approval_id: 'x', summary: 's' })  // notify tier → excluded
    const morning = await composeBoard(s, 'martin', new Date('2026-08-20T08:00:00'))
    expect(morning[0].id).toBe('wx')
    expect(morning.some(w => w.type === 'approval')).toBe(false)
    expect(morning.some(w => w.type === 'housemode')).toBe(true)
    const evening = await composeBoard(s, 'martin', new Date('2026-08-20T20:00:00'))
    expect(evening.some(w => w.type === 'housemode')).toBe(true)
  })
})
