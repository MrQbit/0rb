/**
 * Pluggable voice backend.
 *
 * A backend turns a bidirectional audio WebSocket into agent turns:
 *   browser PCM16 audio  → STT → runChannelTurn → TTS → browser audio
 *
 * Two backends ship:
 *   - whisper     (default) local whisper.cpp STT + energy VAD + Piper TTS
 *   - personaplex (optional) Moshi full-duplex speech model on :8998
 *
 * Selected by ORB2_VOICE_BACKEND (default "whisper"). Both are gated by
 * ORB2_VOICE_ENABLED=1 at the route layer.
 *
 * The interface is shaped for Bun's native ServerWebSocket (callback
 * model, no EventEmitter): the server creates one VoiceSession per
 * socket and routes open/message/close into it.
 */
import type { Store } from '../store/store.js'

/** Outbound sink to the browser socket. */
export type VoiceSend = {
  /** Send a binary audio frame (PCM16) to the browser. */
  audio: (buf: Uint8Array) => void
  /** Send a JSON control/event message to the browser. */
  json: (obj: unknown) => void
}

/** One live voice conversation over a single WebSocket. */
export interface VoiceSession {
  /** A binary audio frame arrived from the browser. */
  onAudio(frame: Uint8Array): void
  /** A JSON control message arrived from the browser. */
  onControl(msg: any): void
  /** Socket closed — release resources. */
  close(): void
}

export type VoiceBackendStatus = {
  backend: string
  ready: boolean
  detail?: Record<string, unknown>
}

export interface VoiceBackend {
  readonly id: string
  /** Cheap readiness probe (binary present / server reachable). */
  isReady(): Promise<boolean>
  getStatus(): Promise<VoiceBackendStatus>
  /** Create a per-socket session bound to the browser sink. */
  createSession(send: VoiceSend, store: Store, sessionId: string): VoiceSession
}

let cached: VoiceBackend | null = null
let cachedId: string | null = null

/** Resolve the configured backend (lazy, cached by id). */
export async function getVoiceBackend(): Promise<VoiceBackend> {
  const id = (process.env.ORB2_VOICE_BACKEND || 'whisper').toLowerCase()
  if (cached && cachedId === id) return cached
  if (id === 'personaplex') {
    const { PersonaplexBackend } = await import('./personaplexBackend.js')
    cached = new PersonaplexBackend()
  } else {
    const { WhisperBackend } = await import('./whisperBackend.js')
    cached = new WhisperBackend()
  }
  cachedId = id
  return cached
}
