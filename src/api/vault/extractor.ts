/**
 * Post-turn memory extraction for the API layer.
 *
 * After each runAgentTurn() completes, this module checks whether extraction
 * should run and, if so, fires a lightweight extraction pass that writes
 * durable facts to the vault. This is the API equivalent of the CLI's
 * extractMemories system.
 *
 * Strategy: call runAgentTurn with an extraction prompt that asks the agent
 * to output JSON-structured memories. Then parse the output and write notes
 * to the vault programmatically. This avoids needing vault tools registered
 * in the agent's tool set.
 *
 * Non-blocking: extraction runs as fire-and-forget after the user gets their
 * response. A Redis-based cursor tracks where the last extraction left off.
 */
import { runAgentTurn } from '../agentRunner.js'
import type { Store } from '../store/store.js'
import { VaultStore } from './store.js'

const CURSOR_PREFIX = 'vault:extract:cursor:'
const LOCK_PREFIX = 'vault:extract:lock:'
const LOCK_TTL = 120 // seconds
const MIN_MESSAGES_FOR_EXTRACTION = 4
const MIN_MESSAGES_BETWEEN_EXTRACTIONS = 4

type ExtractionState = {
  lastMessageIndex: number
  lastRunAt: string
}

type ExtractedMemory = {
  path: string
  content: string
  tags: string[]
}

async function getCursor(store: Store, sessionId: string): Promise<ExtractionState | null> {
  const raw = await store.getKv(`${CURSOR_PREFIX}${sessionId}`)
  return raw ? JSON.parse(raw) : null
}

async function setCursor(store: Store, sessionId: string, state: ExtractionState): Promise<void> {
  await store.putKv(`${CURSOR_PREFIX}${sessionId}`, JSON.stringify(state), 60 * 60 * 24 * 7)
}

async function tryAcquireLock(store: Store, sessionId: string): Promise<boolean> {
  const key = `${LOCK_PREFIX}${sessionId}`
  const existing = await store.getKv(key)
  if (existing) return false
  await store.putKv(key, Date.now().toString(), LOCK_TTL)
  return true
}

async function releaseLock(store: Store, sessionId: string): Promise<void> {
  await store.delKv(`${LOCK_PREFIX}${sessionId}`)
}

function countModelVisibleMessages(messages: unknown[]): number {
  return messages.filter((m: any) =>
    m?.role === 'user' || m?.role === 'assistant' ||
    m?.type === 'user' || m?.type === 'assistant',
  ).length
}

function buildExtractionPrompt(newMessageCount: number, existingNotes: string): string {
  return `You are the memory extraction subagent. Analyze the most recent ~${newMessageCount} messages in this conversation and extract durable knowledge worth persisting.

## What to extract
- Project facts: tech stack, architecture decisions, deployment targets
- User preferences: coding style, tool preferences, workflow patterns
- Key decisions: why something was chosen over alternatives
- Error resolutions: problems encountered and how they were fixed
- Process knowledge: approval flows, deployment steps, team conventions

## What NOT to extract
- Trivial exchanges ("hi", "thanks", status checks)
- Transient debugging (stack traces, log dumps)
- Content already in the vault (check the existing notes below)
- Opinions or speculation without decisions

${existingNotes ? `## Existing vault notes (do NOT duplicate these)\n${existingNotes}\n` : ''}

## Output format
Respond with ONLY a JSON array of memories to write. Each entry:
\`\`\`json
[
  {
    "path": "category/note-name",
    "content": "# Title\\n\\nMarkdown body with [[wikilinks]] to related concepts.",
    "tags": ["tag1", "tag2"]
  }
]
\`\`\`

Rules:
- Use category/ prefix for organization (e.g., "decisions/", "errors/", "process/", "architecture/")
- Content should be Obsidian-compatible markdown with [[wikilinks]]
- If nothing worth extracting, respond with: []
- Maximum 3 notes per extraction
- Keep notes focused -- one topic each`
}

function parseExtractedMemories(text: string): ExtractedMemory[] {
  // Try to find JSON array in the response
  const jsonMatch = text.match(/\[[\s\S]*\]/)
  if (!jsonMatch) return []

  try {
    const parsed = JSON.parse(jsonMatch[0])
    if (!Array.isArray(parsed)) return []
    return parsed.filter((m: any) =>
      typeof m?.path === 'string' &&
      typeof m?.content === 'string' &&
      Array.isArray(m?.tags) &&
      m.content.length > 10
    ).slice(0, 3) // max 3 per extraction
  } catch {
    return []
  }
}

export async function maybeExtractMemories(
  sessionId: string,
  messages: unknown[],
  store: Store,
  model?: string,
): Promise<void> {
  const visibleCount = countModelVisibleMessages(messages)
  if (visibleCount < MIN_MESSAGES_FOR_EXTRACTION) return

  const cursor = await getCursor(store, sessionId)
  const lastIdx = cursor?.lastMessageIndex ?? 0
  const newMessages = visibleCount - lastIdx

  if (newMessages < MIN_MESSAGES_BETWEEN_EXTRACTIONS) return

  const locked = await tryAcquireLock(store, sessionId)
  if (!locked) return

  try {
    const vault = new VaultStore(store)
    const index = await vault.list()
    const existingNotes = index.length > 0
      ? index.map(n => `- ${n.path} [${n.tags.join(', ')}]: ${n.snippet.slice(0, 100)}`).join('\n')
      : ''

    const prompt = buildExtractionPrompt(newMessages, existingNotes)

    console.log(`[extractor] Running extraction for session ${sessionId} (${newMessages} new messages, ${index.length} existing notes)`)

    const result = await runAgentTurn(
      {
        message: prompt,
        model: model || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-6',
        workingDirectory: '/tmp',
        previousMessages: messages as any[],
        signal: AbortSignal.timeout(60_000),
        autoApprove: () => true,
      },
      {
        onLog: (level, msg, data) => {
          if (level === 'error') console.error(`[extractor] ${msg}`, data)
        },
      },
    )

    // Parse the agent's JSON output and write to vault
    const memories = parseExtractedMemories(result.fullText)

    if (memories.length > 0) {
      for (const mem of memories) {
        try {
          await vault.write(mem.path, mem.content, { tags: mem.tags, source: 'extractor', session: sessionId })
          console.log(`[extractor] Wrote note: ${mem.path} [${mem.tags.join(', ')}]`)
        } catch (err) {
          console.error(`[extractor] Failed to write note ${mem.path}:`, (err as Error).message)
        }
      }
      console.log(`[extractor] Extracted ${memories.length} memories for session ${sessionId}`)
    } else {
      console.log(`[extractor] No new memories to extract for session ${sessionId}`)
    }

    await setCursor(store, sessionId, {
      lastMessageIndex: visibleCount,
      lastRunAt: new Date().toISOString(),
    })
  } catch (err) {
    console.error(`[extractor] Extraction failed for session ${sessionId}:`, (err as Error).message)
  } finally {
    await releaseLock(store, sessionId)
  }
}
