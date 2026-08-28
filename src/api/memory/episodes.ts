/**
 * Episodic memory (memory v2): a rolling log of what actually happened in
 * conversations — who said what, what the orb did — kept for a few days so
 * the nightly dream can EXTRACT durable facts from lived days instead of
 * only reorganizing files. Cheap by design: one kv array per day, capped.
 */
import type { Store } from '../store/store.js'

const KEY = (d: string) => `episodes:${d}`
const CAP = 200
const TTL_S = 3 * 24 * 3600

export interface Episode { t: number; who: string; text: string; reply: string; session: string }

const day = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10)

export async function logEpisode(store: Store, e: { who: string; text: string; reply: string; session: string }): Promise<void> {
  try {
    if (!e.text.trim() || e.who === 'dream') return
    // The HTTP path may prepend [SYSTEM: …] context blocks to the message —
    // an episode should hold the person's own words.
    e = { ...e, text: e.text.replace(/^(\[SYSTEM:[\s\S]*?\n\n)+/, '').trim() || e.text }
    const k = KEY(day())
    let arr: Episode[] = []
    try { arr = JSON.parse((await store.getKv(k)) || '[]') } catch { /* fresh */ }
    arr.push({
      t: Date.now(),
      who: e.who.replace(/^user:/, ''),
      text: e.text.slice(0, 220),
      reply: e.reply.slice(0, 240),
      session: e.session.slice(0, 40),
    })
    if (arr.length > CAP) arr = arr.slice(-CAP)
    await store.putKv(k, JSON.stringify(arr), TTL_S)
  } catch { /* memory is best-effort, never the turn's problem */ }
}

/** The last `days` days of episodes, oldest first, at most `max`. */
export async function recentEpisodes(store: Store, days = 2, max = 60): Promise<Episode[]> {
  const out: Episode[] = []
  for (let i = days - 1; i >= 0; i--) {
    try {
      const arr = JSON.parse((await store.getKv(KEY(day(Date.now() - i * 86400_000)))) || '[]')
      if (Array.isArray(arr)) out.push(...arr)
    } catch { /* skip day */ }
  }
  return out.slice(-max)
}
