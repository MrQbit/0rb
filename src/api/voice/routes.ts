import { getVoiceBackend } from './backend.js'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export async function tryHandleVoiceRoute(method: string, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith('/v1/voice')) return null

  if (method === 'GET' && pathname === '/v1/voice/status') {
    const voiceEnabled = process.env.ORB2_VOICE_ENABLED === '1'
    if (!voiceEnabled) {
      return jsonResponse(200, { available: false, reason: 'ORB2_VOICE_ENABLED not set' })
    }
    const backend = await getVoiceBackend()
    const status = await backend.getStatus()
    return jsonResponse(200, {
      available: true,
      backend: status.backend,
      ready: status.ready,
      ws: '/v1/voice/ws',
      ...status.detail,
    })
  }

  return null
}
