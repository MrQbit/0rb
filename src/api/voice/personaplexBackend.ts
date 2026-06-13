/**
 * PersonaPlex (Moshi) voice backend — full-duplex speech model running
 * on :8998. The browser audio is proxied straight to PersonaPlex, which
 * does its own STT/endpointing/TTS; we intercept final_transcript JSON
 * to drive one agent turn and feed the reply text back for synthesis.
 *
 * Optional alternative to the default local whisper.cpp backend; select
 * with RAK00N_VOICE_BACKEND=personaplex.
 */
import type { Store } from '../store/store.js'
import type { VoiceBackend, VoiceBackendStatus, VoiceSend, VoiceSession } from './backend.js'
import { isPersonaplexReady, getPersonaplexStatus } from './personaplex.js'
import { runChannelTurn } from '../channels/runtime.js'
import { log } from '../log.js'

const PERSONAPLEX_WS_URL = (process.env.RAK00N_PERSONAPLEX_URL || 'https://localhost:8998')
  .replace(/^https?:\/\//, 'wss://')

export class PersonaplexBackend implements VoiceBackend {
  readonly id = 'personaplex'

  isReady(): Promise<boolean> {
    return isPersonaplexReady()
  }

  async getStatus(): Promise<VoiceBackendStatus> {
    const s = await getPersonaplexStatus()
    return { backend: this.id, ready: s.running, detail: { url: s.url, voice_prompt: s.voice_prompt } }
  }

  createSession(send: VoiceSend, store: Store, sessionId: string): VoiceSession {
    return new PersonaplexSession(send, store, sessionId)
  }
}

class PersonaplexSession implements VoiceSession {
  private send: VoiceSend
  private store: Store
  private sessionId: string
  private plexWs: any = null
  private closed = false
  private agentText = ''

  constructor(send: VoiceSend, store: Store, sessionId: string) {
    this.send = send
    this.store = store
    this.sessionId = sessionId
    void this.connect()
  }

  private async connect(): Promise<void> {
    try {
      const { WebSocket } = await import('ws' as any)
      this.plexWs = new WebSocket(PERSONAPLEX_WS_URL, { rejectUnauthorized: false })

      this.plexWs.on('message', (data: Buffer | string) => {
        if (Buffer.isBuffer(data)) {
          this.send.audio(new Uint8Array(data))
          return
        }
        void this.onPlexJson(data.toString())
      })
      this.plexWs.on('error', (err: Error) => {
        log.error('voice_personaplex_ws_error', { error: err.message })
        this.send.json({ type: 'error', message: 'PersonaPlex connection error' })
      })
      this.plexWs.on('close', () => log.info('voice_personaplex_ws_closed', { sessionId: this.sessionId }))
    } catch (err) {
      this.send.json({ type: 'error', message: 'Could not connect to PersonaPlex' })
      log.error('voice_personaplex_connect_failed', { error: (err as Error).message })
    }
  }

  private async onPlexJson(raw: string): Promise<void> {
    let event: any
    try { event = JSON.parse(raw) } catch { return }

    if (event.type === 'transcript' && event.text) {
      this.send.json({ type: 'transcript', text: event.text, final: false })
      return
    }
    if (event.type === 'final_transcript' && event.text) {
      this.send.json({ type: 'transcript', text: event.text, final: true })
      this.agentText = await runChannelTurn({ text: event.text, sessionId: this.sessionId, store: this.store })
      if (this.closed) return
      if (this.agentText.trim() && this.plexWs?.readyState === 1) {
        this.plexWs.send(JSON.stringify({ type: 'agent_response', text: this.agentText }))
      }
      this.send.json({ type: 'agent_response', text: this.agentText })
    }
  }

  onAudio(frame: Uint8Array): void {
    if (this.plexWs?.readyState === 1) this.plexWs.send(frame)
  }

  onControl(msg: any): void {
    if (this.plexWs?.readyState === 1) this.plexWs.send(JSON.stringify(msg))
  }

  close(): void {
    this.closed = true
    try { this.plexWs?.close() } catch { /* ignore */ }
  }
}
