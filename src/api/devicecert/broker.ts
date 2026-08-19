/**
 * Client for the central Orb2 device-DNS broker (the Vercel functions at
 * orb2.app/api/device/*). Lets this box claim `<id>.device.orb2.app`, point it
 * at its LAN IP, and set the `_acme-challenge` TXT for a DNS-01 cert.
 *
 * Gated on ORB2_DEVICE_DOMAIN + ORB2_BROKER_URL + ORB2_ENROLL_SECRET.
 */
import os from 'node:os'

export function deviceCertEnabled(): boolean {
  return !!(process.env.ORB2_DEVICE_DOMAIN && process.env.ORB2_BROKER_URL && process.env.ORB2_ENROLL_SECRET)
}

function base(): string {
  return (process.env.ORB2_BROKER_URL || '').replace(/\/+$/, '')
}

async function post(path: string, body: any, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(`${base()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`broker ${path} ${res.status}: ${JSON.stringify(data).slice(0, 160)}`)
  return data
}

export interface DeviceIdentity { device_id: string; hostname: string; token: string }

export function registerDevice(deviceId?: string): Promise<DeviceIdentity> {
  return post('/api/device/register', deviceId ? { device_id: deviceId } : {}, {
    'x-enroll-secret': process.env.ORB2_ENROLL_SECRET || '',
  })
}
export function setA(id: DeviceIdentity, ip: string): Promise<any> {
  return post('/api/device/a', { device_id: id.device_id, token: id.token, ip })
}
export function setTxt(id: DeviceIdentity, value: string): Promise<any> {
  return post('/api/device/txt', { device_id: id.device_id, token: id.token, value })
}
export function clearTxt(id: DeviceIdentity): Promise<any> {
  return post('/api/device/clear', { device_id: id.device_id, token: id.token })
}

/** First non-internal IPv4 address — the LAN IP the broker points the name at. */
export function detectLanIp(): string | null {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address
    }
  }
  return null
}
