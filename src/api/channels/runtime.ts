/**
 * Shared agent-turn runtime for non-HTTP channels (WhatsApp, Telegram,
 * voice, in-proc jobs). Centralises the runAgentTurn boilerplate AND
 * binds the API-native tools (ClusterOps/DockerOps/SelfUpdate/SubmitJob/
 * RunCode/Vault*) so a turn driven from a chat channel has the same
 * capabilities as one driven over HTTP. Previously each channel called
 * runAgentTurn directly without extraTools, so e.g. a WhatsApp message
 * could not drive cluster control.
 */
import { runAgentTurn } from '../agentRunner.js'
import { agentContextPrompt } from '../agentContext.js'
import { buildApiNativeTools } from '../tools/apiNativeTools.js'
import type { Store } from '../store/store.js'
import { makeChannelTodoStore } from './todoStore.js'
import { routeTurn } from '../modelRouter.js'
import { log } from '../log.js'

export type ChannelTurnInput = {
  text: string
  sessionId: string
  ownerId?: string
  store: Store
  /** Streamed text deltas (e.g. for voice interim display / streaming TTS). */
  onText?: (chunk: string) => void
  /** Stream the model output so onText fires incrementally (default false). */
  stream?: boolean
  /**
   * Per-turn paralinguistic context for spoken input — e.g. detected vocal
   * tone and audio events from SenseVoice. Appended to the system prompt for
   * THIS turn only so the agent reacts to *how* something was said without
   * the cue leaking into the visible transcript or conversation history.
   */
  vocalContext?: string
  /** Which surface this turn came from (voice stays local in the router). */
  channel?: string
}

/**
 * Run one agent turn for a channel and return the full assistant text.
 * Errors are caught and returned as a user-facing apology string so the
 * channel always has something to send back.
 */
export async function runChannelTurn(input: ChannelTurnInput): Promise<string> {
  const ownerId = input.ownerId ?? input.sessionId
  const extraTools = buildApiNativeTools({
    store: input.store,
    sessionId: input.sessionId,
    ownerId,
  })

  // Load prior conversation for this session so channel turns (voice,
  // WhatsApp, Telegram) actually REMEMBER — previously each turn was
  // stateless because we never loaded/saved history like the HTTP path does.
  const previousMessages = ((await input.store.getSession(input.sessionId).catch(() => null)) ?? []) as any[]
  const sessionTtl = Number(process.env.RAK00N_API_SESSION_TTL || 604800)

  // Model router: route this turn to a stronger cloud model by intent when
  // enabled (voice stays local for latency). null → local default.
  const providerOverride = routeTurn({ text: input.text, channel: input.channel || 'voice' }) ?? undefined

  let full = ''
  try {
    const result = await runAgentTurn(
      {
        message: input.text,
        previousMessages,
        sessionId: input.sessionId,
        model: process.env.OPENAI_MODEL,
        providerOverride,
        workingDirectory: process.cwd(),
        todoStore: makeChannelTodoStore(input.store),
        extraTools,
        appendSystemPromptExtra: [agentContextPrompt(), input.vocalContext]
          .filter(Boolean)
          .join('\n\n'),
      },
      {
        // The hook is onTextChunk and only fires on streaming deltas; forward
        // it so live UIs get incremental text. With stream:false no deltas
        // fire, so the authoritative reply is the returned fullText below.
        onTextChunk: (chunk: string) => {
          full += chunk
          input.onText?.(chunk)
        },
        onLog: (level, event, data) => {
          if (level === 'error') log.error(event, data as any)
        },
      },
    )
    // Persist the updated conversation so the next turn remembers it.
    if (Array.isArray(result.finalMessages)) {
      await input.store.setSession(input.sessionId, result.finalMessages, sessionTtl).catch(() => {})
    }
    return result.fullText || full
  } catch (err) {
    const msg = `Sorry, I hit an error: ${(err as Error).message}`
    log.error('channel_turn_error', { sessionId: input.sessionId, error: (err as Error).message })
    return msg
  }
}
