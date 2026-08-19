/**
 * Speaker identification — Orb learns each member's voice and knows who is
 * talking.
 *
 * Self-supervised enrollment: every voice utterance in an AUTHENTICATED
 * session contributes to that member's voice profile (a rolling centroid of
 * ECAPA embeddings from the STT service's /embed endpoint). Once profiles
 * exist, each utterance is matched by cosine similarity:
 *   - same person as the session → silent confirmation
 *   - a DIFFERENT enrolled member (e.g. on a shared panel) → the turn's
 *     context notes who it sounds like, so the agent addresses the right
 *     person and applies their preferences
 * Profiles live in the store (family:voice:<email>).
 */
import type { Store } from '../store/store.js'
import { log } from '../log.js'

const VOICE_PREFIX = 'family:voice:'
/** utterances to average before a profile is trusted for matching */
export const ENROLL_MIN = 5
/** rolling window cap — the centroid keeps adapting, slowly */
export const ENROLL_MAX = 40
/** below this cosine similarity a match is not called */
export const MATCH_FLOOR = 0.6
/** margin the best match must beat the runner-up by on shared sessions */
export const MATCH_MARGIN = 0.08

export interface VoiceProfile { centroid: number[]; n: number }

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]! }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** Fold a new sample into a rolling centroid (bounded effective window). */
export function foldCentroid(profile: VoiceProfile | null, emb: number[]): VoiceProfile {
  if (!profile || !profile.centroid.length) return { centroid: [...emb], n: 1 }
  const n = Math.min(profile.n, ENROLL_MAX)
  const w = 1 / (n + 1)
  const centroid = profile.centroid.map((c, i) => c * (1 - w) + (emb[i] ?? 0) * w)
  return { centroid, n: profile.n + 1 }
}

export async function getProfile(store: Store, email: string): Promise<VoiceProfile | null> {
  try {
    const raw = await store.getKv(VOICE_PREFIX + email.toLowerCase())
    return raw ? (JSON.parse(raw) as VoiceProfile) : null
  } catch { return null }
}

async function saveProfile(store: Store, email: string, p: VoiceProfile): Promise<void> {
  await store.putKv(VOICE_PREFIX + email.toLowerCase(), JSON.stringify(p), 0)
}

async function allProfiles(store: Store): Promise<Array<{ email: string; profile: VoiceProfile }>> {
  // Profiles are keyed per member; enumerate via the users db.
  const { getUsers } = await import('../auth/otp.js')
  const users = await getUsers(store)
  const out: Array<{ email: string; profile: VoiceProfile }> = []
  for (const u of users) {
    const p = await getProfile(store, u.email)
    if (p && p.n >= ENROLL_MIN) out.push({ email: u.email, profile: p })
  }
  return out
}

function sttUrl(): string {
  return (process.env.ORB2_STT_URL || '').replace(/\/+$/, '')
}

/** Raw PCM16 mono utterance → embedding via the STT service. null on any failure. */
export async function embedUtterance(pcm: Uint8Array): Promise<number[] | null> {
  const base = sttUrl()
  if (!base) return null
  try {
    const res = await fetch(`${base}/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: pcm as unknown as BodyInit,
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return null
    const d = (await res.json()) as { embedding?: number[] }
    return Array.isArray(d.embedding) ? d.embedding : null
  } catch { return null }
}

export interface SpeakerCheck {
  /** best-matching enrolled member, if any cleared the floor+margin */
  match?: { email: string; similarity: number }
  /** true when the voice does NOT sound like the session's user */
  mismatch: boolean
  enrolled: boolean
}

/**
 * Observe one utterance from an authenticated session: enroll it into the
 * session user's profile and check who it actually sounds like.
 */
export async function observeUtterance(store: Store, sessionEmail: string, pcm: Uint8Array): Promise<SpeakerCheck> {
  const none: SpeakerCheck = { mismatch: false, enrolled: false }
  const email = sessionEmail.toLowerCase()
  if (!email.includes('@')) return none
  const emb = await embedUtterance(pcm)
  if (!emb) return none

  const profiles = await allProfiles(store)
  const scored = profiles
    .map(p => ({ email: p.email, similarity: cosine(p.profile.centroid, emb) }))
    .sort((a, b) => b.similarity - a.similarity)
  const best = scored[0]
  const second = scored[1]

  const own = await getProfile(store, email)
  const ownReady = !!own && own.n >= ENROLL_MIN
  const ownSim = own ? cosine(own.centroid, emb) : 0

  // Enrollment: fold into the session user's profile UNLESS this utterance
  // confidently matches a DIFFERENT member (don't pollute profiles on a
  // shared session).
  const looksLikeSomeoneElse =
    !!best && best.email !== email && best.similarity >= MATCH_FLOOR &&
    (best.similarity - (ownReady ? ownSim : 0)) >= MATCH_MARGIN
  if (!looksLikeSomeoneElse) {
    await saveProfile(store, email, foldCentroid(own, emb))
  }

  const match = best && best.similarity >= MATCH_FLOOR &&
    (!second || best.similarity - second.similarity >= MATCH_MARGIN || best.email === email)
    ? { email: best.email, similarity: best.similarity }
    : undefined
  const mismatch = ownReady && looksLikeSomeoneElse
  if (mismatch) log.info('speaker_mismatch', { session: email, sounds_like: best!.email, sim: best!.similarity.toFixed(2) })
  return { match, mismatch, enrolled: !looksLikeSomeoneElse }
}

/** One-line context for the turn prompt; empty string when unremarkable. */
export function speakerContextLine(check: SpeakerCheck, sessionEmail: string): string {
  if (!check.mismatch || !check.match) return ''
  const who = check.match.email.split('@')[0]
  return `\n[Voice check: this utterance sounds like ${who} (${Math.round(check.match.similarity * 100)}% voice match), not the signed-in user ${sessionEmail.split('@')[0]}. Address the actual speaker naturally.]`
}
