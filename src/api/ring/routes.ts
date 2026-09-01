/**
 * Ring account linking — Settings → Smart home → Ring.
 *
 * The ring-mqtt sidecar owns the Ring credential (one refresh token for
 * live streams, the speaker backchannel, AND — via MQTT discovery into
 * Home Assistant — every sensor the widget needs). Its authenticator web
 * UI (:55123) is a plain HTTP form; we proxy it so the login lives in the
 * Settings panel instead of a raw port, and the running sidecar picks the
 * token up immediately — no restart, no .env edits.
 *
 *   GET  /v1/ring/status   → { running, connected, streams }
 *   POST /v1/ring/connect  → { email, password } | { code }   (owner only)
 *
 * Credentials pass straight through to ring-mqtt; nothing is logged or
 * stored on our side.
 */

const RINGMQTT = 'http://host.docker.internal:55123'
const GO2RTC = 'http://host.docker.internal:1984'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

export async function tryHandleRingRoute(
  method: string, pathname: string, req: Request,
  store: import('../store/store.js').Store, user: string,
): Promise<Response | null> {
  if (!pathname.startsWith('/v1/ring/')) return null

  if (method === 'GET' && pathname === '/v1/ring/status') {
    // Pre-auth: ring-mqtt's authenticator UI answers on :55123. Post-auth it
    // SHUTS DOWN, so the durable signals are our go2rtc's registered streams
    // (ringvoice adds them after MQTT discovery) and, as a fallback, Ring
    // devices present in HA via MQTT discovery.
    let running = false, connected = false, streams: string[] = []
    try {
      const r = await fetch(`${RINGMQTT}/get-state`, { signal: AbortSignal.timeout(2500) })
      if (r.ok) { running = true; connected = !!((await r.json()) as any)?.connected }
    } catch { /* authenticator gone = either not deployed, or already authed */ }
    try {
      const g = await fetch(`${GO2RTC}/api/streams`, { signal: AbortSignal.timeout(2500) })
      if (g.ok) streams = Object.keys((await g.json()) as any).filter(n => n.endsWith('_live'))
    } catch { /* our go2rtc not up */ }
    if (streams.length) { running = true; connected = true }
    if (!connected) {
      try {
        const { haEnabled, haEntityRegistry, haDeviceManufacturers } = await import('../connectors/homeAssistant.js')
        if (haEnabled()) {
          const [reg, mfg] = await Promise.all([haEntityRegistry(), haDeviceManufacturers()])
          if (reg.some(e => /ring/i.test(mfg.get((e as any).device_id || '') || ''))) { running = true; connected = true }
        }
      } catch { /* HA optional */ }
    }
    return jsonResponse(200, { running, connected, streams })
  }

  // Voice-satellite reply fallback: the Ring's own speaker needs a two-way
  // session ring-mqtt's external RTSP can't carry, so when the backchannel
  // isn't available ringvoice POSTs its TTS WAV here and orb answers through
  // the nearest AirPlay speaker instead (Sonos in the same room).
  if (method === 'POST' && pathname === '/v1/ring/speak') {
    if (!user) return jsonResponse(401, { error: 'authentication required' })
    const name = new URL(req.url).searchParams.get('speaker') || 'living room'
    try {
      const { bridgeEnabled, bridgeDevices, bridgeAnnounce } = await import('../connectors/bridge.js')
      if (!bridgeEnabled()) return jsonResponse(503, { error: 'bridge disabled' })
      const { speakers } = await bridgeDevices()
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
      const sp = speakers.find(s => norm(s.name).includes(norm(name)) || norm(name).includes(norm(s.name))) ?? speakers[0]
      if (!sp) return jsonResponse(404, { error: 'no speakers on the network' })
      const wav = new Uint8Array(await req.arrayBuffer())
      if (!wav.length) return jsonResponse(400, { error: 'empty audio body' })
      await bridgeAnnounce(sp.id, wav, 'audio/wav')
      return jsonResponse(200, { ok: true, speaker: sp.name })
    } catch (e) {
      return jsonResponse(502, { error: (e as Error).message })
    }
  }

  if (method === 'POST' && pathname === '/v1/ring/connect') {
    const { isOwner } = await import('../auth/otp.js')
    if (!user || !(await isOwner(store, user))) return jsonResponse(403, { error: 'owner only' })
    const b = await req.json().catch(() => ({})) as any
    const code = String(b?.code || '').trim()
    const email = String(b?.email || '').trim()
    const password = String(b?.password || '')
    let path: string, form: URLSearchParams
    if (code) { path = '/submit-code'; form = new URLSearchParams({ code }) }
    else if (email && password) { path = '/submit-account'; form = new URLSearchParams({ email, password }) }
    else return jsonResponse(400, { error: 'email+password or code required' })
    try {
      const r = await fetch(`${RINGMQTT}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(20_000),
      })
      const j = await r.json().catch(() => ({})) as any
      if (!r.ok) return jsonResponse(r.status === 401 ? 401 : 502, { error: j?.error || `ring-mqtt ${r.status}` })
      return jsonResponse(200, { requires2fa: !!j?.requires2fa, success: !!j?.success })
    } catch (e) {
      return jsonResponse(502, { error: `Ring bridge unreachable — ${(e as Error).message}` })
    }
  }

  return null
}
