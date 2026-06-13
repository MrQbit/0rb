/**
 * First-run setup / claim.
 *
 * A freshly-booted 0rb on the LAN must not be operable by whoever connects
 * first. When setup is required (ORB2_SETUP_REQUIRED=1, the shipped default)
 * and no owner credentials exist yet, the instance is *unclaimed*: every /v1
 * route is locked (423) except this one, and the operator claims it with a
 * one-time **setup code** printed to the host console at boot.
 *
 * Claiming sets the owner username/password, logs them in, and unlocks the box.
 * After that, normal auth applies. In dev (ORB2_SETUP_REQUIRED unset) nothing
 * changes.
 *
 *   GET  /v1/setup/status            → { claimed, needs_setup }
 *   POST /v1/setup/claim   {code,username,password} → set owner + session cookie
 *   POST /v1/setup/home    {url,token}              → connect Home Assistant
 *   POST /v1/setup/location{address}                → set the home location
 */
import type { Store } from '../store/store.js'
import { getCredentials, setCredentials, hashPassword, signSession, sessionCookie, verifySession, parseCookies, SESSION_COOKIE } from '../auth/session.js'
import { haStates } from '../connectors/homeAssistant.js'
import { geocode } from '../connectors/geo.js'
import { log } from '../log.js'

function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extraHeaders } })
}
async function readJson(req: Request): Promise<any> { try { return await req.json() } catch { return {} } }

/** Setup is enforced only when explicitly required (shipped product default). */
export function setupRequired(): boolean {
  return process.env.ORB2_SETUP_REQUIRED === '1'
}

/** The instance is claimed once owner credentials exist. */
export async function isClaimed(store: Store): Promise<boolean> {
  return (await getCredentials(store)) !== null
}

// Once claimed it stays claimed; cache so the per-request gate doesn't hit the
// store on every call.
let claimedOnce = false
export async function isClaimedCached(store: Store): Promise<boolean> {
  if (claimedOnce) return true
  const c = await isClaimed(store)
  if (c) claimedOnce = true
  return c
}

// One-time setup code, generated lazily the first time we need it and printed
// to the console. Stable for the process lifetime.
let setupCode: string | null = null
export function getSetupCode(): string {
  if (!setupCode) {
    // Allow ops to pin it (kiosk provisioning); else generate a friendly code.
    setupCode = (process.env.ORB2_SETUP_CODE || '').trim() ||
      Array.from({ length: 8 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 31)]).join('')
  }
  return setupCode
}

/** Print the setup code once, at boot, when the box is unclaimed. */
export async function announceSetupIfNeeded(store: Store): Promise<void> {
  if (!setupRequired() || (await isClaimed(store))) return
  const code = getSetupCode()
  console.log('\n  ┌──────────────────────────────────────────────┐')
  console.log('  │  0rb is not set up yet.                       │')
  console.log(`  │  Setup code:  ${code.padEnd(31)}│`)
  console.log('  │  Open 0rb in a browser to claim it.          │')
  console.log('  └──────────────────────────────────────────────┘\n')
  log.info('setup_unclaimed', { hint: 'claim with the printed setup code' })
}

export async function tryHandleSetupRoute(
  method: string,
  pathname: string,
  req: Request,
  store: Store,
): Promise<Response | null> {
  if (!pathname.startsWith('/v1/setup')) return null

  if (method === 'GET' && pathname === '/v1/setup/status') {
    return jsonResponse(200, { claimed: await isClaimed(store), needs_setup: setupRequired() && !(await isClaimed(store)) })
  }

  if (method === 'POST' && pathname === '/v1/setup/claim') {
    if (await isClaimed(store)) return jsonResponse(409, { error: 'Already set up', code: 'ALREADY_CLAIMED' })
    const body = await readJson(req)
    const code = String(body?.code || '').trim().toUpperCase()
    const username = String(body?.username || '').trim()
    const password = String(body?.password || '')
    if (code !== getSetupCode().toUpperCase()) {
      log.warn('setup_claim_bad_code', {})
      return jsonResponse(403, { error: 'Wrong setup code', code: 'BAD_CODE' })
    }
    if (username.length < 2 || password.length < 8) {
      return jsonResponse(400, { error: 'Pick a username and a password of at least 8 characters' })
    }
    await setCredentials(store, { username, passHash: hashPassword(password) })
    claimedOnce = true
    log.info('setup_claimed', { username })
    // Auto-login: hand back a session cookie so setup flows straight on.
    const token = signSession(username)
    return jsonResponse(200, { ok: true, username }, { 'set-cookie': sessionCookie(token) })
  }

  // The following run inside the wizard after claim — require the owner session.
  if (pathname === '/v1/setup/home' || pathname === '/v1/setup/location') {
    const cookies = parseCookies(req.headers.get('cookie'))
    if (!verifySession(cookies[SESSION_COOKIE])) {
      return jsonResponse(401, { error: 'Sign in to continue setup', code: 'UNAUTHENTICATED' })
    }
  }

  if (method === 'POST' && pathname === '/v1/setup/home') {
    const body = await readJson(req)
    const url = String(body?.url || '').trim().replace(/\/+$/, '')
    const token = String(body?.token || '').trim()
    if (!url || !token) return jsonResponse(400, { error: 'Home Assistant url and token are required' })
    // Apply for this process + test the connection.
    process.env.ORB2_HA_URL = url
    process.env.ORB2_HA_TOKEN = token
    try {
      const devices = await haStates()
      await persistSetting(store, 'ORB2_HA_URL', url)
      await persistSetting(store, 'ORB2_HA_TOKEN', token)
      log.info('setup_home_connected', { devices: devices.length })
      return jsonResponse(200, { ok: true, devices: devices.length })
    } catch (e) {
      return jsonResponse(502, { error: `Couldn't reach Home Assistant: ${(e as Error).message}`, code: 'HA_UNREACHABLE' })
    }
  }

  if (method === 'POST' && pathname === '/v1/setup/location') {
    const body = await readJson(req)
    const address = String(body?.address || '').trim()
    if (!address) return jsonResponse(400, { error: 'address required' })
    const geo = await geocode(address)
    if (!geo) return jsonResponse(404, { error: `Couldn't locate "${address}"` })
    await persistSetting(store, 'ORB2_HOME_LOCATION', address)
    return jsonResponse(200, { ok: true, resolved: geo.name, lat: geo.lat, lng: geo.lng })
  }

  return null
}

/** Persist a setting to the KV store + live process env (mirrors PUT /v1/settings). */
async function persistSetting(store: Store, key: string, value: string): Promise<void> {
  process.env[key] = value
  try { await store.putKv(`setting:${key}`, value, 60 * 60 * 24 * 3650) } catch { /* best effort */ }
}
