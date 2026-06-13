// End-to-end voice pipeline smoke test (no browser/mic needed).
// Streams a real 16 kHz PCM16 utterance into /v1/voice/ws, then a tail of
// silence to trigger VAD endpointing, and prints every server event:
// transcript → agent_response (Qwen) → audio_start/<pcm>/audio_end.
import { readFileSync } from 'node:fs'

const URL = process.argv[2] || 'ws://localhost:9080/v1/voice/ws'
const PCM = process.argv[3] || '/tmp/rt16.pcm'
const FRAME = 640 // 20ms @ 16kHz mono PCM16

const pcm = readFileSync(PCM)
// Optional auth: pass a session cookie/bearer via env when auth is on.
const COOKIE = process.env.RAK_COOKIE || ''
const BEARER = process.env.RAK_BEARER || ''
const headers = {}
if (COOKIE) headers.Cookie = COOKIE
if (BEARER) headers.Authorization = `Bearer ${BEARER}`
const ws = Object.keys(headers).length ? new WebSocket(URL, { headers }) : new WebSocket(URL)
ws.binaryType = 'arraybuffer'
let audioBytes = 0
const t0 = Date.now()

const log = (...a) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(2)}s]`, ...a)

ws.onopen = async () => {
  log('ws open; streaming', pcm.length, 'bytes of speech')
  for (let i = 0; i < pcm.length; i += FRAME) {
    ws.send(pcm.subarray(i, Math.min(i + FRAME, pcm.length)))
    await new Promise((r) => setTimeout(r, 20)) // real-time pacing
  }
  // ~1.2s of silence to cross the VAD silence threshold and endpoint.
  const silence = new Uint8Array(FRAME)
  for (let i = 0; i < 60; i++) { ws.send(silence); await new Promise((r) => setTimeout(r, 20)) }
  log('done sending; waiting for agent + tts...')
}
ws.onmessage = (ev) => {
  if (typeof ev.data === 'string') {
    const m = JSON.parse(ev.data)
    if (m.type === 'audio_start') log('EVENT audio_start', m)
    else if (m.type === 'audio_end') { log('EVENT audio_end; total TTS pcm bytes =', audioBytes); ws.close() }
    else log('EVENT', JSON.stringify(m))
  } else {
    audioBytes += ev.data.byteLength
  }
}
ws.onclose = () => { log('ws closed'); process.exit(0) }
ws.onerror = (e) => { log('ws error', e.message || e); process.exit(1) }
setTimeout(() => { log('timeout'); process.exit(1) }, 60000)
