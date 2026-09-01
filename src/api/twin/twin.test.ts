import { describe, it, expect } from 'bun:test'
import { getPlan, savePlan, roomOf, devicesIn, roomsOnFloor, nearest, slugify } from './model.js'
import { recordRoomSignal, currentRooms, setShare, getShare, reportLocation, getLocation } from './presence.js'

function memStore(): any {
  const kv = new Map<string, string>()
  return {
    async getKv(k: string) { return kv.get(k) ?? null },
    async putKv(k: string, v: string) { kv.set(k, v) },
    async delKv(k: string) { kv.delete(k) },
  }
}

const PLAN = {
  floors: ['Main', 'Upstairs'],
  rooms: [
    { id: 'living-room', name: 'Living Room', floor: 'Main', x: 0, y: 0 },
    { id: 'kitchen', name: 'Kitchen', floor: 'Main', x: 3, y: 0 },
    { id: 'office', name: 'Office', floor: 'Upstairs', x: 0, y: 0 },
  ],
  placements: {
    'camera.living_room_ring': 'living-room',
    'SONOS-ID': 'living-room',
    'TV-ID': 'kitchen',
    'light.desk': 'office',
  },
}

describe('twin §18', () => {
  it('plan geometry: roomOf, devicesIn, floors, slug', async () => {
    const store = memStore()
    await savePlan(store, PLAN as any)
    const plan = await getPlan(store)
    expect(roomOf(plan, 'camera.living_room_ring')?.name).toBe('Living Room')
    expect(devicesIn(plan, 'living-room').sort()).toEqual(['SONOS-ID', 'camera.living_room_ring'])
    expect(roomsOnFloor(plan, 'upstairs').map(r => r.id)).toEqual(['office'])
    expect(slugify('Living Room!')).toBe('living-room')
  })

  it('nearest: same room beats same floor beats other floor', () => {
    const plan = PLAN as any
    expect(nearest(plan, 'camera.living_room_ring', ['SONOS-ID', 'TV-ID'])).toBe('SONOS-ID')
    expect(nearest(plan, 'camera.living_room_ring', ['TV-ID', 'light.desk'])).toBe('TV-ID')
  })

  it('room signals record and fade honestly', async () => {
    const store = memStore()
    await recordRoomSignal(store, 'living-room', 'motion')
    const live = await currentRooms(store)
    expect(live['living-room']?.source).toBe('motion')
  })

  it('CONSENT: only the member themself can enable location sharing', async () => {
    const store = memStore()
    const owner = 'owner@example.com', kid = 'kid@example.com'
    const r = await setShare(store, owner, kid, true)          // owner forcing another member
    expect(r.ok).toBe(false)
    expect(await getShare(store, kid)).toBe(false)
    expect((await setShare(store, kid, kid, true)).ok).toBe(true)
    expect(await getShare(store, kid)).toBe(true)
  })

  it('location reports are refused without opt-in, and revoke forgets', async () => {
    const store = memStore()
    const m = 'martin@example.com'
    expect((await reportLocation(store, m, '9v6kpry')).ok).toBe(false)
    await setShare(store, m, m, true)
    expect((await reportLocation(store, m, '9v6kpry')).ok).toBe(true)
    expect((await getLocation(store, m))?.geohash).toBe('9v6kpry')
    await setShare(store, m, m, false)
    expect(await getLocation(store, m)).toBeNull()
  })
})
