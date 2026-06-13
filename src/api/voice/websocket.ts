/**
 * Bun-native WebSocket glue for /v1/voice/ws.
 *
 * Bun's ServerWebSocket uses a callback model (open/message/close on the
 * Bun.serve config) rather than per-socket EventEmitters, so we keep one
 * VoiceSession per socket in ws.data and route the callbacks into it.
 * The actual STT/TTS work lives in the selected VoiceBackend.
 */
import type { Store } from '../store/store.js'
import { getVoiceBackend, type VoiceSession, type VoiceSend } from './backend.js'
import { log } from '../log.js'

export type VoiceWsData = {
  kind: 'voice'
  sessionId: string
  session?: VoiceSession
}

/** Decide whether a request should upgrade to the voice WebSocket. */
export function isVoiceWsRequest(pathname: string): boolean {
  return pathname === '/v1/voice/ws'
}

/** Build the per-socket data passed to server.upgrade(). A client-supplied
 * session id (the chat session) unifies voice + text memory. */
export function makeVoiceWsData(sessionId?: string | null): VoiceWsData {
  const sid = sessionId && /^[A-Za-z0-9:_-]{6,80}$/.test(sessionId)
    ? sessionId
    : `voice:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return { kind: 'voice', sessionId: sid }
}

/** Bun websocket handlers for voice sockets. */
export function voiceWebSocketHandlers(store: Store) {
  return {
    async open(ws: any) {
      const data = ws.data as VoiceWsData
      const send: VoiceSend = {
        audio: (buf: Uint8Array) => { try { ws.send(buf) } catch { /* closed */ } },
        json: (obj: unknown) => { try { ws.send(JSON.stringify(obj)) } catch { /* closed */ } },
      }
      try {
        const backend = await getVoiceBackend()
        const ready = await backend.isReady()
        if (!ready) {
          send.json({ type: 'error', message: `voice backend '${backend.id}' not ready` })
        }
        data.session = backend.createSession(send, store, data.sessionId)
        // Forward typed widgets emitted during voice turns (same bus as chat).
        try {
          const { onWidget } = await import('../widgets/bus.js')
          ;(data as any).unsubWidgets = onWidget(data.sessionId, spec => send.json({ type: 'widget', spec }))
        } catch { /* widgets optional */ }
        send.json({ type: 'ready', backend: backend.id })
        log.info('voice_ws_open', { sessionId: data.sessionId, backend: backend.id })
      } catch (err) {
        send.json({ type: 'error', message: (err as Error).message })
        log.error('voice_ws_open_failed', { error: (err as Error).message })
      }
    },
    message(ws: any, message: string | Buffer | Uint8Array) {
      const data = ws.data as VoiceWsData
      const session = data.session
      if (!session) return
      if (typeof message === 'string') {
        try { session.onControl(JSON.parse(message)) } catch { /* ignore */ }
      } else {
        const u8 = message instanceof Uint8Array ? message : new Uint8Array(message as ArrayBufferLike)
        session.onAudio(u8)
      }
    },
    close(ws: any) {
      const data = ws.data as VoiceWsData
      try { (data as any).unsubWidgets?.() } catch { /* */ }
      data.session?.close()
      log.info('voice_ws_close', { sessionId: data?.sessionId })
    },
  }
}
