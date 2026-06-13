/**
 * Session message compaction for the API layer.
 *
 * When a session's message history exceeds the context window threshold,
 * older messages are summarized into a compact boundary and the session
 * is updated in Redis. This prevents prompt-too-long errors for long
 * conversations.
 *
 * This is the API equivalent of the CLI's autoCompact system.
 */
import { runAgentTurn } from '../agentRunner.js'
import type { Store } from '../store/store.js'

const DEFAULT_CONTEXT_WINDOW = 200_000
const COMPACT_THRESHOLD_RATIO = 0.75
const MAX_SUMMARY_TOKENS = 4_000
const CHARS_PER_TOKEN = 4 // rough estimate

function estimateTokens(messages: unknown[]): number {
  let total = 0
  for (const msg of messages) {
    const m = msg as any
    // Handle both Anthropic API format (content) and internal Message format (message.content)
    const content = m?.content ?? m?.message?.content
    if (typeof content === 'string') {
      total += Math.ceil(content.length / CHARS_PER_TOKEN)
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === 'string') {
          total += Math.ceil(block.length / CHARS_PER_TOKEN)
        } else if (block?.text) {
          total += Math.ceil(block.text.length / CHARS_PER_TOKEN)
        } else if (block?.type === 'tool_use') {
          total += Math.ceil(JSON.stringify(block.input || {}).length / CHARS_PER_TOKEN)
        } else if (block?.type === 'tool_result') {
          const content = block.content
          if (typeof content === 'string') total += Math.ceil(content.length / CHARS_PER_TOKEN)
          else if (Array.isArray(content)) {
            for (const c of content) {
              if (c?.text) total += Math.ceil(c.text.length / CHARS_PER_TOKEN)
            }
          }
        }
      }
    }
  }
  return total
}

function getContextWindow(model?: string): number {
  const override = process.env.ORB2_MAX_CONTEXT_TOKENS
  if (override) {
    const n = parseInt(override, 10)
    if (!isNaN(n) && n > 0) return n
  }
  if (!model) return DEFAULT_CONTEXT_WINDOW
  const lower = model.toLowerCase()
  if (lower.includes('opus')) return 200_000
  if (lower.includes('sonnet')) return 200_000
  if (lower.includes('haiku')) return 200_000
  if (lower.includes('gpt-5')) return 128_000
  if (lower.includes('codex')) return 128_000
  return DEFAULT_CONTEXT_WINDOW
}

function buildCompactPrompt(): string {
  return `Summarize the conversation so far into a concise but complete summary that preserves:
1. All key facts, decisions, and outcomes
2. File paths, tool outputs, and technical details that were discussed
3. The user's intent and what was accomplished
4. Any pending tasks or unresolved questions
5. Error resolutions and important findings

Format as a structured summary with sections. Be concise but do NOT drop important technical details like file paths, command outputs, config values, or error messages.
Keep the summary under 2000 words. Start with "## Session Summary" as the header.`
}

export type CompactResult = {
  compacted: boolean
  originalTokens: number
  compactedTokens: number
  messagesRemoved: number
}

/**
 * Check if session messages need compaction, and if so, compact them.
 * Returns the (possibly compacted) message array.
 */
export async function maybeCompactSession(
  sessionId: string,
  messages: unknown[],
  store: Store,
  model?: string,
): Promise<{ messages: unknown[]; result: CompactResult }> {
  const tokens = estimateTokens(messages)
  const contextWindow = getContextWindow(model)
  const threshold = Math.floor(contextWindow * COMPACT_THRESHOLD_RATIO)

  if (tokens < threshold) {
    return {
      messages,
      result: { compacted: false, originalTokens: tokens, compactedTokens: tokens, messagesRemoved: 0 },
    }
  }

  console.log(`[compactor] Session ${sessionId}: ${tokens} tokens exceeds threshold ${threshold}, compacting...`)

  // Keep the most recent 25% of messages, summarize the rest
  const keepCount = Math.max(4, Math.floor(messages.length * 0.25))
  const oldMessages = messages.slice(0, messages.length - keepCount)
  const recentMessages = messages.slice(messages.length - keepCount)

  try {
    const result = await runAgentTurn(
      {
        message: buildCompactPrompt(),
        model: model || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-6',
        workingDirectory: '/tmp',
        previousMessages: oldMessages as any[],
        signal: AbortSignal.timeout(30_000),
        autoApprove: () => true,
      },
      {},
    )

    const summary = result.fullText
    if (!summary || summary.length < 50) {
      console.warn(`[compactor] Summary too short, skipping compaction`)
      return {
        messages,
        result: { compacted: false, originalTokens: tokens, compactedTokens: tokens, messagesRemoved: 0 },
      }
    }

    // Build compacted message array: [summary as system-like user message, ...recent]
    const compactBoundary = {
      role: 'user',
      content: `[This is a summary of the earlier conversation. The original messages have been compacted to save context space.]\n\n${summary}`,
    }
    const compactedMessages = [compactBoundary, ...recentMessages]
    const compactedTokens = estimateTokens(compactedMessages)

    // Persist
    await store.setSession(sessionId, compactedMessages, 60 * 60 * 24 * 7)

    console.log(`[compactor] Session ${sessionId}: compacted ${tokens} -> ${compactedTokens} tokens (removed ${oldMessages.length} messages)`)

    return {
      messages: compactedMessages,
      result: {
        compacted: true,
        originalTokens: tokens,
        compactedTokens,
        messagesRemoved: oldMessages.length,
      },
    }
  } catch (err) {
    console.error(`[compactor] Compaction failed for session ${sessionId}:`, (err as Error).message)
    return {
      messages,
      result: { compacted: false, originalTokens: tokens, compactedTokens: tokens, messagesRemoved: 0 },
    }
  }
}
