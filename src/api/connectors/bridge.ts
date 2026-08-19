/**
 * LAN bridge client — the host-network sidecar that sees the real network:
 * AirPlay speakers/TVs and IPP printers, discovered and driven directly
 * (no Home Assistant setup required). See services/bridge/server.py.
 */

export interface BridgeSpeaker { id: string; name: string; address: string; model: string; protocols: string[] }
export interface BridgePrinter { id: string; name: string; address: string; port: number; rp: string; pdl: string[]; location: string }

export function bridgeUrl(): string {
  return (process.env.ORB2_BRIDGE_URL || '').replace(/\/+$/, '')
}
export function bridgeEnabled(): boolean {
  return !!bridgeUrl()
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...extra }
  if (process.env.ORB2_BRIDGE_TOKEN) h['X-Bridge-Token'] = process.env.ORB2_BRIDGE_TOKEN
  return h
}

async function call(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${bridgeUrl()}${path}`, {
    ...init,
    headers: headers({ 'content-type': 'application/json', ...(init?.headers as any) }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`bridge ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

export async function bridgeDevices(): Promise<{ speakers: BridgeSpeaker[]; printers: BridgePrinter[] }> {
  return call('/devices')
}
export async function bridgePlay(id: string, url: string, volume?: number): Promise<void> {
  await call('/play', { method: 'POST', body: JSON.stringify({ id, url, ...(volume != null && { volume }) }) })
}
export async function bridgeStop(id: string): Promise<void> {
  await call('/stop', { method: 'POST', body: JSON.stringify({ id }) })
}
export async function bridgeVolume(id: string, level: number): Promise<void> {
  await call('/volume', { method: 'POST', body: JSON.stringify({ id, level }) })
}
export async function bridgeStatus(id: string): Promise<{ playing: boolean; since?: number; volume?: number }> {
  return call(`/status?id=${encodeURIComponent(id)}`)
}

/** Play raw audio (WAV/MP3 bytes) on a speaker — the announce path. */
export async function bridgeAnnounce(id: string, audio: Uint8Array, contentType = 'audio/wav', volume?: number): Promise<void> {
  const q = volume != null ? `&volume=${volume}` : ''
  const res = await fetch(`${bridgeUrl()}/announce?id=${encodeURIComponent(id)}${q}`, {
    method: 'POST', headers: headers({ 'content-type': contentType }), body: audio as unknown as BodyInit,
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`bridge announce ${res.status}: ${(await res.text()).slice(0, 200)}`)
}

export async function bridgePrinterStatus(id: string): Promise<{ ok: boolean; state: string; reasons: string[]; make: string; formats: string[] }> {
  return call(`/printer?id=${encodeURIComponent(id)}`)
}
export async function bridgePrint(id: string, doc: Uint8Array, format: string, name: string): Promise<{ ok: boolean; job_id?: number; ipp_status?: number }> {
  const res = await fetch(`${bridgeUrl()}/print?id=${encodeURIComponent(id)}&format=${encodeURIComponent(format)}&name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: headers({ 'content-type': 'application/octet-stream' }), body: doc as unknown as BodyInit,
    signal: AbortSignal.timeout(60_000),
  })
  const body: any = await res.json().catch(() => ({}))
  if (!res.ok && !body.ipp_status) throw new Error(`bridge print ${res.status}`)
  return body
}

// UPnP (router) — the bridge does the SSDP/SOAP legwork on the host network.
export async function bridgeUpnpStatus(): Promise<{ gateway: boolean; external_ip?: string | null }> {
  return call('/upnp')
}
export async function bridgeUpnpMap(port: number, internalIp?: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${bridgeUrl()}/upnp/map`, {
    method: 'POST', headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ port, ...(internalIp && { internal_ip: internalIp }) }),
    signal: AbortSignal.timeout(20_000),
  })
  return await res.json().catch(() => ({ ok: false, error: `bridge ${res.status}` })) as any
}

/** Resolve a speaker/printer by fuzzy name ("living room" → Living Room). */
export function bridgeResolve<T extends { name: string }>(devices: T[], query: string): T | undefined {
  const q = query.trim().toLowerCase()
  if (!q) return undefined
  return devices.find(d => d.name.toLowerCase() === q)
    ?? devices.find(d => d.name.toLowerCase().includes(q))
    ?? devices.find(d => q.includes(d.name.toLowerCase()))
}

/** Wrap raw PCM16LE mono in a WAV header (what the TTS service emits → what
 *  the bridge/pyatv can stream). */
export function pcmToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const header = new ArrayBuffer(44)
  const v = new DataView(header)
  const write = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)) }
  write(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true); write(8, 'WAVE')
  write(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  write(36, 'data'); v.setUint32(40, pcm.length, true)
  const out = new Uint8Array(44 + pcm.length)
  out.set(new Uint8Array(header), 0); out.set(pcm, 44)
  return out
}
