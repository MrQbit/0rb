/**
 * Vision: lets the agent "look" at the latest video frame via moondream2.
 *
 * Frames live ONLY in memory (a per-session latest-frame buffer, no disk) —
 * the A/V ingest writes them, the Vision tool reads them. What the agent
 * actually *saw* (captions / answers) IS persisted to the kv store as a
 * sighting log, so there's a durable memory of what came through the camera
 * without keeping the raw frames.
 */
import type { Store } from '../store/store.js'

export function visionUrl(): string {
  return (process.env.RAK00N_VISION_URL || '').replace(/\/+$/, '')
}
export function visionEnabled(): boolean {
  return !!visionUrl()
}

// LLM-native vision: send the frame straight to the multimodal brain (the same
// vLLM the agent talks to) as an image content block, instead of a separate
// vision service (moondream2). Enabled with RAK00N_VISION_BACKEND=llm; falls back
// to moondream when set to anything else. Either backend makes the tool show up.
export function llmVisionEnabled(): boolean {
  const backend = (process.env.RAK00N_VISION_BACKEND || '').toLowerCase()
  return backend === 'llm' && !!process.env.OPENAI_BASE_URL
}
export function visionToolAvailable(): boolean {
  return visionEnabled() || llmVisionEnabled()
}

async function captionViaLLM(frame: Frame, question: string): Promise<string> {
  const base = (process.env.OPENAI_BASE_URL || '').replace(/\/+$/, '')
  const model = process.env.OPENAI_MODEL || 'qwen3-coder-next'
  const dataUri = `data:image/jpeg;base64,${Buffer.from(frame.jpeg).toString('base64')}`
  const prompt = question || 'Describe what you see in this image in 1-3 concise, factual sentences.'
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (process.env.OPENAI_API_KEY) headers.authorization = `Bearer ${process.env.OPENAI_API_KEY}`
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUri } },
        ],
      }],
      max_tokens: 300,
      temperature: 0.2,
      // Hybrid-thinking model: turn off the reasoning trace for a clean caption.
      chat_template_kwargs: { enable_thinking: false },
    }),
  })
  if (!res.ok) throw new Error(`LLM vision ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  let out = (data?.choices?.[0]?.message?.content || '').trim()
  // Defensively strip any <think>…</think> block if thinking still slipped in.
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '').trim()
  return out || '(no result)'
}

// ── in-memory latest frame per owner (NO disk) ──
// Keyed by the user identity (single-user owner), not the chat session: the
// user shares their camera once and rak00n can look at the latest frame in
// any conversation. The server assigns its own session ids, so they can't be
// aligned with a client-side stream anyway.
type Frame = { jpeg: Uint8Array; ts: number }
const frames = new Map<string, Frame>()
const OWNER = (key: string) => key || 'owner'

export function setFrame(ownerKey: string, jpeg: Uint8Array): void {
  frames.set(OWNER(ownerKey), { jpeg, ts: Date.now() })
}
export function getFrame(ownerKey: string): Frame | undefined {
  return frames.get(OWNER(ownerKey))
}
export function clearFrame(ownerKey: string): void {
  frames.delete(OWNER(ownerKey))
}

// ── sighting log (persisted: the memory of what was seen) ──
const SIGHTINGS_KEY = (s: string) => `vision:sightings:${s}`
const MAX_SIGHTINGS = 50
const SIGHTINGS_TTL_S = 60 * 60 * 24 * 7 // 7 days

type Sighting = { ts: string; text: string }

async function addSighting(store: Store, sessionId: string, text: string): Promise<void> {
  let arr: Sighting[] = []
  try {
    const raw = await store.getKv(SIGHTINGS_KEY(sessionId))
    if (raw) arr = JSON.parse(raw) as Sighting[]
  } catch { /* ignore */ }
  arr.push({ ts: new Date().toISOString(), text })
  if (arr.length > MAX_SIGHTINGS) arr = arr.slice(-MAX_SIGHTINGS)
  await store.putKv(SIGHTINGS_KEY(sessionId), JSON.stringify(arr), SIGHTINGS_TTL_S)
}

export async function recentSightings(store: Store, sessionId: string, limit = 20): Promise<Sighting[]> {
  try {
    const raw = await store.getKv(SIGHTINGS_KEY(sessionId))
    if (raw) return (JSON.parse(raw) as Sighting[]).slice(-limit)
  } catch { /* ignore */ }
  return []
}

// ── the agent tool: look at the current frame ──
export async function executeVision(
  args: { question?: string },
  ctx: { store: Store; ownerId: string },
): Promise<string> {
  const useLLM = llmVisionEnabled()
  if (!useLLM && !visionEnabled()) return 'Vision is not configured (set RAK00N_VISION_BACKEND=llm or RAK00N_VISION_URL).'
  // Try the turn's owner key, then the shared 'owner' key the camera also
  // writes to (voice turns are keyed by session id, not identity).
  const frame = getFrame(ctx.ownerId) || getFrame('owner')
  if (!frame) {
    return 'No live video frame is available right now. Ask the user to start sharing their camera from the console.'
  }
  const ageS = Math.round((Date.now() - frame.ts) / 1000)
  const question = (args?.question || '').trim()

  let out: string
  try {
    if (useLLM) {
      out = await captionViaLLM(frame, question)
    } else {
      let res: Response
      if (question) {
        res = await fetch(`${visionUrl()}/query`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ image_b64: Buffer.from(frame.jpeg).toString('base64'), question }),
        })
      } else {
        res = await fetch(`${visionUrl()}/caption`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: frame.jpeg as any,
        })
      }
      if (!res.ok) return `Vision error (${res.status}).`
      const data = (await res.json()) as { caption?: string; answer?: string }
      out = (question ? data.answer : data.caption) || '(no result)'
    }
  } catch (e) {
    return `Vision unreachable: ${(e as Error).message}`
  }
  await addSighting(ctx.store, ctx.ownerId, question ? `Q: ${question} → ${out}` : out).catch(() => {})
  return ageS > 5 ? `${out}\n(frame is ${ageS}s old)` : out
}
