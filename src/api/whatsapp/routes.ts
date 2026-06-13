/**
 * WhatsApp routes — proxy to the dedicated bridge service (services/whatsapp,
 * default http://whatsapp:8995). The bridge holds the WhatsApp Web session;
 * we surface its status + QR to the authenticated console so the owner can
 * link their account without leaving the orb page.
 *
 *   GET /v1/whatsapp/status   → { enabled, connected, me, qr_available, ... }
 *   GET /v1/whatsapp/qr       → image/png while unlinked (202 if not ready)
 */
function bridgeUrl(): string {
  return (process.env.ORB2_WHATSAPP_BRIDGE_URL || 'http://whatsapp:8995').replace(/\/+$/, '')
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

export async function tryHandleWhatsAppRoute(method: string, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith('/v1/whatsapp')) return null

  if (method === 'GET' && pathname === '/v1/whatsapp/status') {
    try {
      const r = await fetch(`${bridgeUrl()}/status`)
      const d = (await r.json()) as Record<string, unknown>
      return jsonResponse(200, { enabled: true, connected: !!d.connected, ...d })
    } catch {
      return jsonResponse(200, { enabled: false, connected: false, reason: 'bridge unreachable' })
    }
  }

  if (method === 'GET' && pathname === '/v1/whatsapp/qr') {
    try {
      const r = await fetch(`${bridgeUrl()}/qr`)
      const ct = r.headers.get('content-type') || ''
      if (ct.includes('image')) {
        const buf = new Uint8Array(await r.arrayBuffer())
        return new Response(buf, { status: 200, headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } })
      }
      // Not an image yet (connected, or QR not ready) — pass the JSON through.
      return new Response(await r.text(), { status: r.status, headers: { 'content-type': 'application/json' } })
    } catch {
      return jsonResponse(502, { error: 'whatsapp bridge unreachable' })
    }
  }

  return null
}
