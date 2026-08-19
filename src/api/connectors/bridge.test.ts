import { describe, test, expect, afterEach, afterAll } from 'bun:test'
import { bridgeEnabled, bridgeResolve, pcmToWav, bridgeDevices } from './bridge.ts'

const REAL_FETCH = globalThis.fetch
const savedUrl = process.env.ORB2_BRIDGE_URL
afterEach(() => { globalThis.fetch = REAL_FETCH })
afterAll(() => { if (savedUrl == null) delete process.env.ORB2_BRIDGE_URL; else process.env.ORB2_BRIDGE_URL = savedUrl })

describe('bridge connector', () => {
  test('enabled only when a bridge URL is configured', () => {
    process.env.ORB2_BRIDGE_URL = ''
    expect(bridgeEnabled()).toBe(false)
    process.env.ORB2_BRIDGE_URL = 'http://host.docker.internal:8997'
    expect(bridgeEnabled()).toBe(true)
  })

  test('resolve matches exact, substring, and reverse-substring names', () => {
    const devs = [{ name: 'Living Room' }, { name: '[LG] webOS TV QNED70AUA' }]
    expect(bridgeResolve(devs, 'living room')?.name).toBe('Living Room')
    expect(bridgeResolve(devs, 'webos')?.name).toBe('[LG] webOS TV QNED70AUA')
    expect(bridgeResolve(devs, 'the living room speaker')?.name).toBe('Living Room')
    expect(bridgeResolve(devs, 'kitchen')).toBeUndefined()
    expect(bridgeResolve(devs, '')).toBeUndefined()
  })

  test('pcmToWav wraps PCM in a valid RIFF header', () => {
    const pcm = new Uint8Array([1, 2, 3, 4])
    const wav = pcmToWav(pcm, 24000)
    expect(wav.length).toBe(48)
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE')
    const dv = new DataView(wav.buffer)
    expect(dv.getUint32(24, true)).toBe(24000)      // sample rate
    expect(dv.getUint16(22, true)).toBe(1)          // mono
    expect(dv.getUint32(40, true)).toBe(4)          // data length
    expect(wav.slice(44)).toEqual(pcm)
  })

  test('devices call hits /devices and returns the payload', async () => {
    process.env.ORB2_BRIDGE_URL = 'http://bridge.test'
    let calledUrl = ''
    globalThis.fetch = (async (url: any) => {
      calledUrl = String(url)
      return new Response(JSON.stringify({ speakers: [{ name: 'Living Room' }], printers: [] }), { status: 200 })
    }) as any
    const d = await bridgeDevices()
    expect(calledUrl).toBe('http://bridge.test/devices')
    expect(d.speakers[0]!.name).toBe('Living Room')
  })
})
