/**
 * Local voice backend: whisper.cpp (STT) + energy VAD + Piper (TTS).
 *
 * No external service — runs entirely from two binaries on the host:
 *   ORB2_WHISPER_BIN    whisper.cpp CLI (default "whisper-cli")
 *   ORB2_WHISPER_MODEL  GGUF/GGML model path (e.g. ggml-base.en.bin)
 *   ORB2_PIPER_BIN      Piper CLI (default "piper")
 *   ORB2_PIPER_MODEL    Piper ONNX voice (e.g. en_US-amy-medium.onnx)
 *
 * Protocol with the browser (continuous, GPT-style — no push-to-talk):
 *   browser → server : binary PCM16 mono 16 kHz frames (streamed live)
 *   server → browser : {type:'transcript', text, final}          (STT)
 *                      {type:'agent_response', text}              (agent)
 *                      {type:'audio_start', sample_rate}          (TTS begin)
 *                      <binary PCM16 frames>                      (TTS audio)
 *                      {type:'audio_end'}                         (TTS done)
 *
 * Endpointing is server-side VAD: we detect end-of-utterance from a
 * trailing-silence window, transcribe the captured segment, run one
 * agent turn, then synthesize the reply. While the agent is speaking,
 * fresh speech energy from the user cancels playback (barge-in).
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import type { Store } from '../store/store.js'
import type { VoiceBackend, VoiceBackendStatus, VoiceSend, VoiceSession } from './backend.js'
import { runChannelTurn } from '../channels/runtime.js'
import { log } from '../log.js'

const SAMPLE_RATE = 16000
const BYTES_PER_SAMPLE = 2

/** One transcribed utterance plus its paralinguistics (when SenseVoice). */
type Heard = { text: string; emotion: string; events: string[] }

/**
 * Turn SenseVoice's emotion/event tags into a short, per-turn system-prompt
 * note so the cascade brain reacts to *how* something was said. Kept terse
 * and explicitly "do not repeat" so the model treats it as subtext, not
 * something to read aloud. Returns '' when nothing notable was heard.
 */
function buildVocalContext(heard: Heard): string | undefined {
  const emotion = (heard.emotion || '').trim()
  const events = (heard.events || []).filter(e => e && e !== 'background music')
  if (!emotion && !events.length) return undefined
  const parts: string[] = []
  if (emotion) parts.push(`their tone of voice sounded ${emotion}`)
  if (events.length) parts.push(`audible in the recording: ${events.join(', ')}`)
  return (
    `VOICE DELIVERY (this message only, inferred from audio — not the words): ` +
    `${parts.join('; ')}. Let this emotional subtext shape your warmth, pacing and word choice; ` +
    `acknowledge the feeling naturally if it fits. Never quote, list, or announce these cues.`
  )
}

function whisperBin() { return process.env.ORB2_WHISPER_BIN || 'whisper-cli' }
function whisperModel() { return process.env.ORB2_WHISPER_MODEL || '' }
function piperBin() { return process.env.ORB2_PIPER_BIN || 'piper' }
function piperModel() { return process.env.ORB2_PIPER_MODEL || '' }
function piperSampleRate() { return Number(process.env.ORB2_PIPER_SAMPLE_RATE || 22050) }

// Optional GPU voice services (see services/stt, services/tts). When set,
// STT/TTS are delegated to these HTTP endpoints instead of local binaries,
// giving GPU faster-whisper transcription and Kokoro neural TTS while the
// VAD/endpointing/barge-in/agent-turn flow below stays identical.
function sttUrl() { return (process.env.ORB2_STT_URL || '').replace(/\/+$/, '') }
function ttsUrl() { return (process.env.ORB2_TTS_URL || '').replace(/\/+$/, '') }
function ttsVoice() { return process.env.ORB2_TTS_VOICE || 'af_heart' }

/**
 * Make agent text speakable: drop emoji and markdown punctuation so TTS
 * doesn't read "smiling face" / "asterisk asterisk". The on-screen reply
 * keeps the original text; only the spoken copy is cleaned.
 */
export function cleanForTts(text: string): string {
  return (text || '')
    // emoji + pictographs + symbols + dingbats + variation selectors
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}]/gu, '')
    .replace(/```[\s\S]*?```/g, ' code block ')   // fenced code → a phrase
    .replace(/`([^`]+)`/g, '$1')                  // inline code ticks
    .replace(/[*_#>~|]/g, '')                     // md emphasis/heading/quote/table
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')    // links/images → label
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function vadThreshold() { return Number(process.env.ORB2_VOICE_VAD_THRESHOLD || 500) }
function silenceMs() { return Number(process.env.ORB2_VOICE_SILENCE_MS || 800) }
function minSpeechMs() { return Number(process.env.ORB2_VOICE_MIN_SPEECH_MS || 300) }

/** Cheap health probe for an STT/TTS HTTP service. */
async function httpOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

async function which(bin: string): Promise<boolean> {
  if (bin.includes('/')) return existsSync(bin)
  try {
    const p = Bun.spawn(['sh', '-c', `command -v ${bin}`], { stdout: 'pipe', stderr: 'ignore' })
    await p.exited
    return p.exitCode === 0
  } catch {
    return false
  }
}

export class WhisperBackend implements VoiceBackend {
  readonly id = 'whisper'

  async isReady(): Promise<boolean> {
    // GPU STT service takes precedence over a local whisper.cpp binary.
    if (sttUrl()) return httpOk(`${sttUrl()}/health`)
    if (!whisperModel() || !existsSync(whisperModel())) return false
    return which(whisperBin())
  }

  async getStatus(): Promise<VoiceBackendStatus> {
    const usingHttpStt = !!sttUrl()
    const sttReady = usingHttpStt
      ? await httpOk(`${sttUrl()}/health`)
      : !!whisperModel() && existsSync(whisperModel()) && (await which(whisperBin()))
    const usingHttpTts = !!ttsUrl()
    const ttsReady = usingHttpTts
      ? await httpOk(`${ttsUrl()}/health`)
      : !!piperModel() && existsSync(piperModel()) && (await which(piperBin()))
    return {
      backend: this.id,
      ready: sttReady,
      detail: {
        stt: usingHttpStt ? `gpu:${sttUrl()}` : `whisper.cpp:${whisperBin()}`,
        stt_ready: sttReady,
        tts: usingHttpTts
          ? `gpu-neural:${ttsUrl()} (${ttsVoice()})`
          : ttsReady ? 'piper' : 'none (text-only replies)',
        tts_ready: ttsReady,
      },
    }
  }

  createSession(send: VoiceSend, store: Store, sessionId: string): VoiceSession {
    return new WhisperSession(send, store, sessionId)
  }
}

class WhisperSession implements VoiceSession {
  private send: VoiceSend
  private store: Store
  private sessionId: string

  private capturing = false
  private speechMs = 0
  private trailingSilenceMs = 0
  private segments: Uint8Array[] = []
  private preRoll: Uint8Array[] = []
  private busy = false
  private closed = false
  private ttsActive = false
  // Barge-in hardening: ignore the orb hearing its own voice through speakers.
  private ttsStartAt = 0   // when the current TTS playback began (ms epoch)
  private bargeMs = 0      // accumulated sustained loud-speech while TTS plays
  // Streaming-TTS pipeline state (sentence queue speaks while the model writes).
  private ttsStarted = false
  private ttsCancelled = false
  private sentenceQueue: string[] = []

  constructor(send: VoiceSend, store: Store, sessionId: string) {
    this.send = send
    this.store = store
    this.sessionId = sessionId
  }

  onControl(msg: any): void {
    if (msg?.type === 'reset') {
      this.capturing = false
      this.segments = []
      this.speechMs = 0
      this.trailingSilenceMs = 0
    } else if (msg?.type === 'interrupt') {
      // Manual barge-in: the user tapped to stop the agent mid-sentence.
      this.ttsCancelled = true
      this.sentenceQueue = []
      if (this.ttsActive) {
        this.ttsActive = false
        this.send.json({ type: 'audio_cancel' })
      }
    }
  }

  onAudio(frame: Uint8Array): void {
    if (this.closed) return
    const ms = (frame.length / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000
    const energy = rms16(frame)
    const voiced = energy >= vadThreshold()

    // Barge-in, hardened against the orb hearing its OWN voice (no AEC): only
    // after a short grace period, and only on sustained energy above an
    // elevated bar (echo is quieter and shorter than real interrupting speech).
    if (this.ttsActive) {
      const loud = energy >= vadThreshold() * 1.8
      const pastGrace = Date.now() - this.ttsStartAt > 600
      if (loud) this.bargeMs += ms
      else this.bargeMs = 0
      if (pastGrace && this.bargeMs >= 220) {
        this.ttsActive = false
        this.ttsCancelled = true
        this.sentenceQueue = []
        this.bargeMs = 0
        this.send.json({ type: 'audio_cancel' })
      }
    }

    if (!this.capturing) {
      // Keep a short pre-roll so we don't clip the start of speech.
      this.preRoll.push(frame)
      const preRollMs = this.preRoll.reduce((a, f) => a + (f.length / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000, 0)
      while (this.preRoll.length > 1 && preRollMs > 250) this.preRoll.shift()
      if (voiced) {
        this.capturing = true
        this.segments = [...this.preRoll]
        this.preRoll = []
        this.speechMs = ms
        this.trailingSilenceMs = 0
      }
      return
    }

    this.segments.push(frame)
    if (voiced) {
      this.speechMs += ms
      this.trailingSilenceMs = 0
    } else {
      this.trailingSilenceMs += ms
    }

    if (this.trailingSilenceMs >= silenceMs() && this.speechMs >= minSpeechMs()) {
      const captured = concat(this.segments)
      this.capturing = false
      this.segments = []
      this.speechMs = 0
      this.trailingSilenceMs = 0
      void this.finalize(captured)
    }
  }

  close(): void {
    this.closed = true
    this.segments = []
    this.preRoll = []
  }

  private async finalize(pcm: Uint8Array): Promise<void> {
    if (this.busy || this.closed) return
    this.busy = true
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const wavPath = join(tmpdir(), `orb2-voice-${stamp}.wav`)
    try {
      writeFileSync(wavPath, wavFromPcm16(pcm, SAMPLE_RATE))
      const heard = await this.transcribe(wavPath)
      const transcript = (heard.text || '').trim()
      if (!transcript) return
      // The user only ever sees the clean transcript; the paralinguistic
      // cues ride in a separate channel into the prompt.
      this.send.json({ type: 'transcript', text: transcript, final: true, emotion: heard.emotion || undefined })
      const vocalContext = buildVocalContext(heard)

      // ── Streaming TTS: speak sentences as the model writes them ──
      // Reset the streaming pipeline for this turn.
      this.ttsStarted = false
      this.ttsCancelled = false
      this.sentenceQueue = []
      const usingHttpTts = !!ttsUrl()
      let buffer = ''
      let llmDone = false

      const drainSentences = (flushAll: boolean) => {
        const re = /([\s\S]*?[.!?。！？]+)(\s|$)/
        let m: RegExpExecArray | null
        while ((m = re.exec(buffer)) && m[1].trim()) {
          const consumed = m.index + m[1].length + (m[2] ? m[2].length : 0)
          this.sentenceQueue.push(m[1].trim())
          buffer = buffer.slice(consumed)
        }
        // Flush an over-long terminator-less buffer so we don't stall.
        if (!flushAll && buffer.length > 220) { this.sentenceQueue.push(buffer.trim()); buffer = '' }
        if (flushAll && buffer.trim()) { this.sentenceQueue.push(buffer.trim()); buffer = '' }
      }

      // The pump speaks queued sentences concurrently with generation.
      const pump = usingHttpTts ? (async () => {
        while (!this.ttsCancelled && !this.closed) {
          if (!this.sentenceQueue.length) {
            if (llmDone) break
            await new Promise(r => setTimeout(r, 12)); continue
          }
          if (this.ttsStarted && !this.ttsActive) break    // barge-in
          // Coalesce queued sentences into a larger batch (after the first,
          // low-latency one). Re-opening an Orpheus request per sentence adds a
          // ~370ms startup gap each time, which reads as an unnatural pause at
          // every '.'. Batching to ~240 chars keeps the cadence continuous.
          const cap = this.ttsStarted ? 240 : 0
          const parts: string[] = [this.sentenceQueue.shift() as string]
          while (this.sentenceQueue.length &&
                 parts.join(' ').length + (this.sentenceQueue[0]?.length ?? 0) <= cap) {
            parts.push(this.sentenceQueue.shift() as string)
          }
          const spoken = cleanForTts(parts.join(' '))
          if (!spoken) continue
          await this.streamSentence(spoken).catch(e => log.warn('tts_sentence_failed', { error: (e as Error).message }))
        }
        if (this.ttsStarted && this.ttsActive && !this.closed) this.send.json({ type: 'audio_end' })
        this.ttsActive = false
      })() : Promise.resolve()

      const reply = await runChannelTurn({
        text: transcript,
        sessionId: this.sessionId,
        store: this.store,
        stream: usingHttpTts,
        vocalContext,
        onText: usingHttpTts ? (chunk: string) => { buffer += chunk; drainSentences(false) } : undefined,
      })
      llmDone = true
      drainSentences(true)
      if (this.closed) return
      this.send.json({ type: 'agent_response', text: reply })
      if (usingHttpTts) {
        await pump
      } else {
        const spoken = cleanForTts(reply)
        if (spoken) await this.speak(spoken)
      }
    } catch (err) {
      log.error('voice_finalize_error', { error: (err as Error).message })
      this.send.json({ type: 'error', message: (err as Error).message })
    } finally {
      try { rmSync(wavPath, { force: true }) } catch { /* ignore */ }
      this.busy = false
    }
  }

  private async transcribe(wavPath: string): Promise<Heard> {
    // GPU STT service: POST the captured WAV, get back the rich payload.
    // SenseVoice adds {emotion, events}; faster-whisper returns just {text}.
    if (sttUrl()) {
      const wav = readFileSync(wavPath)
      const res = await fetch(`${sttUrl()}/transcribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: wav,
      })
      if (!res.ok) throw new Error(`stt http ${res.status}`)
      const data = (await res.json()) as { text?: string; emotion?: string; events?: string[] }
      return {
        text: (data.text || '').trim(),
        emotion: (data.emotion || '').trim(),
        events: Array.isArray(data.events) ? data.events : [],
      }
    }

    const model = whisperModel()
    if (!model) throw new Error('ORB2_WHISPER_MODEL not set')
    // -nt: no timestamps → stdout is plain transcript text.
    const proc = Bun.spawn(
      [whisperBin(), '-m', model, '-f', wavPath, '-nt', '-l', process.env.ORB2_WHISPER_LANG || 'auto'],
      { stdout: 'pipe', stderr: 'ignore' },
    )
    const out = await new Response(proc.stdout).text()
    await proc.exited
    return { text: out.replace(/\[[^\]]*\]/g, '').trim(), emotion: '', events: [] }
  }

  private async speak(text: string): Promise<void> {
    if (ttsUrl()) { await this.speakHttp(text); return }
    if (!piperModel() || !(await which(piperBin()))) return // text-only
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const outWav = join(tmpdir(), `orb2-tts-${stamp}.wav`)
    try {
      const proc = Bun.spawn([piperBin(), '-m', piperModel(), '-f', outWav], {
        stdin: 'pipe',
        stdout: 'ignore',
        stderr: 'ignore',
      })
      proc.stdin.write(text)
      proc.stdin.end()
      await proc.exited
      if (this.closed || !existsSync(outWav)) return

      const wav = readFileSync(outWav)
      const pcm = stripWavHeader(wav)
      this.ttsActive = true; this.ttsStartAt = Date.now(); this.bargeMs = 0
      this.send.json({ type: 'audio_start', sample_rate: piperSampleRate() })
      // Stream in ~40ms chunks so the browser can start playback early
      // and barge-in stays responsive.
      const chunkBytes = Math.floor((piperSampleRate() * BYTES_PER_SAMPLE * 40) / 1000)
      for (let i = 0; i < pcm.length && this.ttsActive && !this.closed; i += chunkBytes) {
        this.send.audio(pcm.subarray(i, Math.min(i + chunkBytes, pcm.length)))
      }
      this.send.json({ type: 'audio_end' })
      this.ttsActive = false
    } finally {
      try { rmSync(outWav, { force: true }) } catch { /* ignore */ }
    }
  }

  /**
   * GPU neural TTS: stream PCM16 from the Kokoro service as it synthesizes.
   * The browser plays at the service's reported sample rate (24 kHz). We
   * stop forwarding the moment barge-in flips ttsActive off (or the socket
   * closes), so the user can cut the agent off mid-sentence.
   */
  /**
   * Stream one sentence's PCM under the shared audio envelope: send a single
   * `audio_start` on the first sentence, then forward PCM for each. The pump
   * sends `audio_end` once generation + speaking finish. This lets the orb
   * start talking on sentence 1 while the model is still writing the rest.
   */
  private async streamSentence(text: string): Promise<void> {
    if (this.ttsCancelled || this.closed) return
    const res = await fetch(`${ttsUrl()}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, voice: ttsVoice() }),
    })
    if (!res.ok || !res.body) throw new Error(`tts http ${res.status}`)
    const sampleRate = Number(res.headers.get('x-sample-rate')) || 24000
    if (!this.ttsStarted) {
      this.ttsStarted = true
      this.ttsActive = true; this.ttsStartAt = Date.now(); this.bargeMs = 0
      this.send.json({ type: 'audio_start', sample_rate: sampleRate })
    }
    const reader = res.body.getReader()
    let carry: Uint8Array | null = null
    try {
      while (this.ttsActive && !this.closed && !this.ttsCancelled) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value || value.length === 0) continue
        let buf: Uint8Array = value
        if (carry) { buf = concat([carry, buf]); carry = null }
        if (buf.length & 1) { carry = buf.subarray(buf.length - 1); buf = buf.subarray(0, buf.length - 1) }
        if (buf.length) this.send.audio(buf)
      }
    } finally {
      try { await reader.cancel() } catch { /* ignore */ }
    }
  }

  private async speakHttp(text: string): Promise<void> {
    const res = await fetch(`${ttsUrl()}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, voice: ttsVoice() }),
    })
    if (!res.ok || !res.body) throw new Error(`tts http ${res.status}`)
    const sampleRate = Number(res.headers.get('x-sample-rate')) || 24000

    this.ttsActive = true; this.ttsStartAt = Date.now(); this.bargeMs = 0
    this.send.json({ type: 'audio_start', sample_rate: sampleRate })
    const reader = res.body.getReader()
    // The service may hand us odd-length chunks; carry a stray byte so we
    // never split a PCM16 sample across frames.
    let carry: Uint8Array | null = null
    try {
      while (this.ttsActive && !this.closed) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value || value.length === 0) continue
        let buf: Uint8Array = value
        if (carry) { buf = concat([carry, buf]); carry = null }
        if (buf.length & 1) { carry = buf.subarray(buf.length - 1); buf = buf.subarray(0, buf.length - 1) }
        if (buf.length) this.send.audio(buf)
      }
    } finally {
      try { await reader.cancel() } catch { /* ignore */ }
    }
    if (this.ttsActive && !this.closed) this.send.json({ type: 'audio_end' })
    this.ttsActive = false
  }
}

// ─────────────────────── audio helpers ───────────────────────

function rms16(buf: Uint8Array): number {
  const n = Math.floor(buf.length / 2)
  if (n === 0) return 0
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let sum = 0
  for (let i = 0; i < n; i++) {
    const s = view.getInt16(i * 2, true)
    sum += s * s
  }
  return Math.sqrt(sum / n)
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

/** Wrap raw PCM16 mono samples in a minimal 44-byte WAV header. */
function wavFromPcm16(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const header = new ArrayBuffer(44)
  const v = new DataView(header)
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)) }
  const dataLen = pcm.length
  writeStr(0, 'RIFF')
  v.setUint32(4, 36 + dataLen, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  v.setUint32(16, 16, true)        // fmt chunk size
  v.setUint16(20, 1, true)         // PCM
  v.setUint16(22, 1, true)         // mono
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true) // byte rate
  v.setUint16(32, BYTES_PER_SAMPLE, true)              // block align
  v.setUint16(34, 16, true)        // bits per sample
  writeStr(36, 'data')
  v.setUint32(40, dataLen, true)
  const out = new Uint8Array(44 + dataLen)
  out.set(new Uint8Array(header), 0)
  out.set(pcm, 44)
  return out
}

/** Return the PCM payload of a WAV by locating the "data" chunk. */
function stripWavHeader(wav: Uint8Array): Uint8Array {
  // Scan for the "data" chunk id rather than assuming a 44-byte header.
  for (let i = 12; i + 8 <= wav.length; ) {
    const id = String.fromCharCode(wav[i]!, wav[i + 1]!, wav[i + 2]!, wav[i + 3]!)
    const size = wav[i + 4]! | (wav[i + 5]! << 8) | (wav[i + 6]! << 16) | (wav[i + 7]! << 24)
    if (id === 'data') return wav.subarray(i + 8, i + 8 + size)
    i += 8 + size + (size & 1)
  }
  return wav.subarray(Math.min(44, wav.length))
}
