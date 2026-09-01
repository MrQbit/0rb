/**
 * The headless worker turn for one standing intent (SPEC §15).
 *
 * Reuses the full channel runtime — native tools, memory recall, consent
 * gradient, receipts, episode logging — so a background check is exactly as
 * capable as a chat turn, just unattended. Each run is STATELESS by design:
 * continuity lives in the intent's `state` scratchpad (carried in the
 * charter), not in session history, so cost per run stays bounded forever.
 */
import type { Store } from '../store/store.js'
import type { Intent } from './engine.js'

export async function runIntentTurn(store: Store, intent: Intent): Promise<void> {
  const { runChannelTurn } = await import('../channels/runtime.js')
  const charter = [
    `[BACKGROUND WATCH — no human is present. You are executing a standing intent you hold for ${intent.member}.]`,
    ``,
    `GOAL: ${intent.goal}`,
    intent.state ? `YOUR NOTES FROM LAST RUN:\n${intent.state}` : `This is the first run — establish the baseline (e.g. current price, current status) and store it in your notes.`,
    ``,
    `Do the MINIMUM checking needed right now (a few tool calls: search, connected services, home devices). Then you MUST finish by calling the Watch tool with op:'report' and intent_id:'${intent.id}':`,
    `- outcome:'quiet'  → nothing worth the user's attention; put updated notes (baseline, what you saw, date) in 'state'.`,
    `- outcome:'notify' → the condition hit or something noteworthy happened; 'message' = ONE short sentence for the user (what + numbers + suggested next step). Also update 'state'.`,
    `- outcome:'done'   → the goal is fulfilled or no longer makes sense; say why in 'message'.`,
    `Rules: never place orders or take approval-gated actions here — recommend in the message instead, and the user will act. Don't notify twice about the same fact (check your notes). If a check fails (site down, no data), report quiet and note the failure. After the report call, reply with one short line.`,
  ].filter(Boolean).join('\n')

  await runChannelTurn({
    text: charter,
    // Fresh session per run: state carries context, not chat history.
    sessionId: `intent:${intent.id}:r${intent.runs}`,
    ownerId: intent.member,
    store,
    channel: 'intent',
  })
}
