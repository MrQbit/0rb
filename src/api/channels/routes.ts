/**
 * Channel status REST endpoint. Surfaces every registered channel's
 * configured/connected state so the UI can render a single channels
 * panel (WhatsApp QR, Telegram link status, ...).
 *
 *   GET /v1/channels → { channels: ChannelStatus[] }
 */
import { listChannelStatus, registerAllChannels } from './index.js'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export async function tryHandleChannelsRoute(method: string, pathname: string): Promise<Response | null> {
  if (pathname !== '/v1/channels') return null
  if (method !== 'GET') return null
  // Ensure channels are registered even if startChannels hasn't run
  // (e.g. status checked before any channel was configured).
  registerAllChannels()
  return jsonResponse(200, { channels: listChannelStatus() })
}
