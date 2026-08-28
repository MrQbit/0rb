/**
 * One place that assembles the per-turn context every surface shares:
 * who is talking (family/profile/permissions), their personal memory, and
 * the memories automatically recalled for what they just said. Used by the
 * HTTP chat paths AND runChannelTurn (voice/WhatsApp/Telegram/routines) —
 * previously channel turns got no family context at all.
 */
import type { Store } from '../store/store.js'

export async function turnContextExtra(store: Store, ownerId: string, text: string): Promise<string> {
  const parts: string[] = []
  try {
    const { familyPromptExtra } = await import('../family/family.js')
    parts.push(await familyPromptExtra(store, ownerId))
  } catch { /* optional */ }
  try {
    const { recallBlock } = await import('../memory/autoRecall.js')
    parts.push(await recallBlock(store, text))
  } catch { /* optional */ }
  return parts.filter(Boolean).join('\n')
}
