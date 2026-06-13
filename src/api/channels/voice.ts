/**
 * Voice channel — reports voice backend availability to /v1/channels.
 * The actual WebSocket handler lives in src/api/voice/websocket.ts;
 * this is a read-only status adapter so the channels panel can show it.
 */
import type { Store } from '../store/store.js'
import type { Channel, ChannelStatus } from './types.js'

let backendReady = false
let backendResolved = false

async function resolveBackend(): Promise<void> {
  if (backendResolved) return
  backendResolved = true
  try {
    const { getVoiceBackend } = await import('../voice/backend.js')
    const b = await getVoiceBackend()
    backendReady = await b.isReady().catch(() => false)
  } catch {
    backendReady = false
  }
}

export class VoiceChannel implements Channel {
  readonly id = 'voice'
  readonly name = 'Voice'

  isConfigured(): boolean {
    return process.env.RAK00N_VOICE_ENABLED === '1'
  }

  async start(_store: Store): Promise<void> {
    await resolveBackend()
  }

  async stop(): Promise<void> {}

  getStatus(): ChannelStatus {
    const configured = this.isConfigured()
    const connected = configured && backendReady
    const detail: Record<string, unknown> | undefined = configured
      ? { backend: process.env.RAK00N_VOICE_BACKEND || 'whisper' }
      : undefined
    return { id: this.id, name: this.name, configured, connected, detail }
  }
}
