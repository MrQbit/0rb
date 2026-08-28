import { describe, test, expect } from 'bun:test'
import { associateCamera, listCamEvents } from './events.ts'

describe('remote eyes (SPEC §12)', () => {
  test('sensor→camera association: area first, then name, then first', () => {
    const cams = [
      { entity_id: 'camera.porch', name: 'Porch Camera', area: 'Porch' },
      { entity_id: 'camera.hall', name: 'Hallway Camera', area: 'Hallway' },
    ]
    expect(associateCamera({ name: 'Hallway Motion', area: 'Hallway' }, cams)!.entity_id).toBe('camera.hall')
    expect(associateCamera({ name: 'Hallway Motion' }, cams)!.entity_id).toBe('camera.hall')      // name overlap
    expect(associateCamera({ name: 'Kitchen Window', area: 'Kitchen' }, cams)!.entity_id).toBe('camera.porch') // fallback: first
    expect(associateCamera({ name: 'x' }, [])).toBeNull()
  })

  test('empty ring reads clean', async () => {
    const kv = new Map<string, string>()
    const s = { async getKv(k: string) { return kv.get(k) ?? null }, async putKv(k: string, v: string) { kv.set(k, v) }, async delKv(k: string) { kv.delete(k) } } as any
    expect(await listCamEvents(s)).toHaveLength(0)
  })
})
