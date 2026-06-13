/**
 * Async chat-request consumer.
 *
 * Pops "task.invoke" envelopes from the input queue, runs the same
 * `agentRunner.runAgentTurn()` flow used by the synchronous /v1/chat
 * and /a2a HTTP entry points, then publishes a "task.result.ready"
 * (or "task.failed") envelope to the output queue for the AG UI
 * server to render.
 *
 * Agent logic is NOT modified by this module. It is a pure I/O
 * adapter between RabbitMQ and `runAgentTurn`.
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { runAgentTurn } from '../agentRunner.js'
import type { Store } from '../store/store.js'
import { consumeFromInputQueue, publishToFabric } from './rabbit.js'
import type { FabricMessageEnvelope } from './types.js'
import { log } from '../log.js'

type RequestEnvelopeBody = {
  userId?: string
  contextId?: string
  message: string
  messageId?: string
  agentResponseId?: string
  agentId?: string
  metadata?: Record<string, unknown> & { bearerToken?: string; model?: string }
}

type RequestEnvelope = {
  messageId: string
  messageType: string
  correlationId?: string
  body: RequestEnvelopeBody
}

function ensureDir(dir: string) {
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* already exists or no permission */
  }
}

function buildResultEnvelope(
  req: RequestEnvelope,
  body: Partial<RequestEnvelopeBody> & { state: string; metadata?: Record<string, unknown> },
  messageType: 'task.status.updated' | 'task.result.ready' | 'task.failed' | 'task.message.delta',
): FabricMessageEnvelope {
  return {
    messageId: randomUUID(),
    messageType,
    correlationId: req.correlationId ?? req.body.messageId,
    messageVersion: '1.0',
    messageTimestamp: new Date().toISOString(),
    source: 'orb2-api',
    body: {
      userId: req.body.userId,
      contextId: req.body.contextId,
      rootTaskId: req.correlationId ?? req.body.messageId,
      message: body.message ?? '',
      messageId: req.body.messageId,
      agentResponseId: req.body.agentResponseId,
      state: body.state,
      agentId: req.body.agentId ?? 'orb2-api',
      timestamp: new Date().toISOString(),
      metadata: body.metadata,
    },
  }
}

export function startRequestConsumer(ctx: { store: Store; sessionTtlSeconds: number }): Promise<boolean> {
  return consumeFromInputQueue(async (raw) => {
    const env = raw as RequestEnvelope
    if (!env || typeof env !== 'object' || !env.body || typeof env.body.message !== 'string') {
      console.error('[requestConsumer] invalid envelope shape, rejecting')
      return 'reject'
    }
    if (env.messageType !== 'task.invoke') {
      console.warn(`[requestConsumer] unsupported messageType=${env.messageType}, rejecting`)
      return 'reject'
    }

    const sessionId = env.body.contextId ?? randomUUID()
    const workspaceRoot = process.env.ORB2_API_WORKSPACE_ROOT || '/workspace'
    const workingDirectory = path.join(workspaceRoot, sessionId)
    ensureDir(workingDirectory)

    const previousMessages = (await ctx.store.getSession(sessionId)) ?? []
    const mcpToken = env.body.metadata?.bearerToken
    const model = env.body.metadata?.model

    log.info('rabbit.request.received', {
      correlationId: env.correlationId,
      sessionId,
      messageId: env.body.messageId,
      mcp_token_forwarded: !!mcpToken,
      mcp_token_len: typeof mcpToken === 'string' ? mcpToken.length : 0,
      model: model ?? null,
      messageLen: typeof env.body.message === 'string' ? env.body.message.length : 0,
      messagePreview:
        typeof env.body.message === 'string' ? env.body.message.slice(0, 200) : '',
      previousMessageCount: previousMessages.length,
      metadataKeys: Object.keys(env.body.metadata ?? {}),
    })

    // No task.status.updated{working} publish: agui-server's
    // TaskStatusUpdatedStrategy only consumes "input-required". The UI
    // infers "working" from RUN_STARTED + TEXT_MESSAGE_START emitted by
    // MessageDeltaStrategy on the first delta. Publishing "working"
    // here just floods the DLQ.

    // Streaming strategy:
    //   - Buffer text in memory and only publish a batch every
    //     FLUSH_INTERVAL_MS or once it grows past FLUSH_CHAR_THRESHOLD
    //   - Lazily publish the streamPhase=start envelope on the FIRST
    //     real flush (not eagerly), so that if a tool call happens
    //     before any text is shown, the UI never sees a text bubble
    //   - On the first onToolStart, abort streaming entirely:
    //     drop pending buffer, mark streamAborted, suppress future
    //     publishes. Later we send task.result.ready{alreadyStreamed}
    //     so the widget pipeline takes over
    let pendingChunk = ''
    let lastFlushAt = Date.now()
    let streamStartPublished = false
    let streamAborted = false
    const FLUSH_INTERVAL_MS = 120
    const FLUSH_CHAR_THRESHOLD = 64

    const ensureStreamStart = async () => {
      if (streamStartPublished || streamAborted) return
      streamStartPublished = true
      await publishToFabric(
        buildResultEnvelope(
          env,
          { state: 'streaming', message: '', metadata: { streamPhase: 'start' } },
          'task.message.delta',
        ),
      )
    }

    const flushPendingChunk = async () => {
      if (streamAborted) {
        pendingChunk = ''
        return
      }
      if (pendingChunk.length === 0) return
      const chunk = pendingChunk
      pendingChunk = ''
      lastFlushAt = Date.now()
      await ensureStreamStart()
      await publishToFabric(
        buildResultEnvelope(
          env,
          { state: 'streaming', message: chunk, metadata: { streamPhase: 'delta' } },
          'task.message.delta',
        ),
      )
    }

    const onTextChunk = async (text: string) => {
      if (streamAborted) return
      pendingChunk += text
      const now = Date.now()
      if (
        pendingChunk.length >= FLUSH_CHAR_THRESHOLD ||
        now - lastFlushAt >= FLUSH_INTERVAL_MS
      ) {
        await flushPendingChunk()
      }
    }

    let hadToolCall = false
    let lastToolResultItems: unknown[] | null = null
    let lastWidgetName: string | null = null
    let lastWidgetPayload: Record<string, unknown> | null = null

    // Some MCP servers prepend descriptive text before their JSON payload,
    // e.g. `"Fabric Workspaces:\n\n[{...}]"`. Strict JSON.parse fails on those,
    // so when direct parse fails we look for the first `{` or `[` and try
    // again from there.
    const tryParseLoose = (text: string): unknown => {
      try {
        return JSON.parse(text)
      } catch {
        const firstObj = text.indexOf('{')
        const firstArr = text.indexOf('[')
        const candidates = [firstObj, firstArr].filter(i => i >= 0)
        if (candidates.length === 0) return null
        const start = Math.min(...candidates)
        const tail = text.slice(start)
        try {
          return JSON.parse(tail)
        } catch {
          return null
        }
      }
    }

    const parseToolOutput = (rawOutput: string): unknown => {
      const top = tryParseLoose(rawOutput)
      if (top === null) return null
      let parsed: unknown = top
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        'content' in (parsed as Record<string, unknown>)
      ) {
        const content = (parsed as Record<string, unknown>).content
        if (Array.isArray(content) && content.length > 0) {
          const first = content[0] as Record<string, unknown>
          if (typeof first?.text === 'string') {
            const inner = tryParseLoose(first.text as string)
            if (inner !== null) parsed = inner
          }
        }
      }
      return parsed
    }

    // Pull a renderable list out of an MCP tool's parsed JSON result.
    //   1. If the top-level value is itself an array, return it.
    //   2. Try a curated set of known keys (covers Fabric MCP shapes:
    //      list_workspaces => { workspaces }, get_start_methods =>
    //      { start_methods }, get_starter_kits => { starter_kits },
    //      get_engagement_codes => { engagement_codes }, list-typed
    //      MCP servers => { items / data / results / records }, the
    //      provisioning poller => { steps }, license MCP => { licenses
    //      / license_types / teams / members }).
    //   3. Generic fallback: pick the FIRST array-valued non-meta key
    //      so future tools that return { foo_things: [...] } also
    //      render as a list widget without a code change here. Skip
    //      internal/diagnostic keys that start with '_' or whose value
    //      is empty.
    const META_KEY_RX = /^_/
    const KNOWN_LIST_KEYS = [
      'items', 'workspaces', 'data', 'results', 'records', 'steps',
      'start_methods', 'starter_kits', 'engagement_codes',
      'applications', 'integrations',
      'licenses', 'license_types', 'teams', 'members',
    ] as const
    const tryExtractItemsFromParsed = (parsed: unknown): unknown[] | null => {
      if (Array.isArray(parsed)) return parsed
      if (!parsed || typeof parsed !== 'object') return null
      const obj = parsed as Record<string, unknown>
      for (const key of KNOWN_LIST_KEYS) {
        const value = obj[key]
        if (Array.isArray(value) && value.length > 0) return value
      }
      for (const [key, value] of Object.entries(obj)) {
        if (META_KEY_RX.test(key)) continue
        if (Array.isArray(value) && value.length > 0) return value
      }
      return null
    }

    const isProvisioningStatusTool = (toolName: string): boolean => {
      const lower = toolName.toLowerCase()
      return lower.endsWith('get_application_provisioning_status')
    }

    // Detects the agent's `<lang=review-summary>` fenced block (or
    // ```review-summary ... ``` variants) and lifts the JSON payload into a
    // first-class agui widget. Returns { payload, cleanedText } when a valid
    // block is found, otherwise null.
    const REVIEW_SUMMARY_FENCE = /```\s*review-summary\s*\n([\s\S]*?)\n```/i
    const tryExtractReviewSummary = (
      fullText: string,
    ): { payload: Record<string, unknown>; cleanedText: string } | null => {
      const match = fullText.match(REVIEW_SUMMARY_FENCE)
      if (!match) return null
      try {
        const parsed = JSON.parse(match[1])
        if (
          parsed &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed) &&
          typeof (parsed as Record<string, unknown>).title === 'string' &&
          Array.isArray((parsed as Record<string, unknown>).fields) &&
          (parsed as Record<string, unknown>).primaryAction &&
          typeof (parsed as Record<string, unknown>).primaryAction === 'object'
        ) {
          const cleanedText = fullText.replace(REVIEW_SUMMARY_FENCE, '').trim()
          return { payload: parsed as Record<string, unknown>, cleanedText }
        }
      } catch {
        /* not valid JSON */
      }
      return null
    }

    const buildStepProgressPayload = (parsed: unknown): Record<string, unknown> | null => {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      const obj = parsed as Record<string, unknown>
      const steps = obj.steps
      if (!Array.isArray(steps)) return null
      const overallStatus = typeof obj.overallStatus === 'string' ? obj.overallStatus : 'InProgress'
      const applicationId = typeof obj.application_id === 'string' ? obj.application_id : null
      const payload: Record<string, unknown> = {
        title: 'Application Provisioning',
        overallStatus,
        steps,
      }
      if (applicationId) payload.applicationId = applicationId
      const repo = obj.repository as Record<string, unknown> | undefined
      if (repo && typeof repo === 'object') {
        const repoUrl = typeof repo.url === 'string' ? repo.url : null
        if (repoUrl) {
          const repoStatus = typeof repo.status === 'string' ? repo.status : 'Success'
          payload.outcomes = [{ label: 'Repository', url: repoUrl, status: repoStatus }]
        }
      }
      return payload
    }

    const onToolStart = async () => {
      // First tool invocation — give up on streaming so the UI isn't
      // briefly shown a placeholder text that the widget will replace.
      hadToolCall = true
      streamAborted = true
      pendingChunk = ''
    }

    const onToolResult = async (event: {
      toolName: string
      output: string
      isError: boolean
    }) => {
      hadToolCall = true
      if (event.isError) return
      const parsed = parseToolOutput(event.output)
      if (isProvisioningStatusTool(event.toolName)) {
        const widgetPayload = buildStepProgressPayload(parsed)
        if (widgetPayload) {
          lastWidgetName = 'step-progress'
          lastWidgetPayload = widgetPayload
          return
        }
      }
      const items = tryExtractItemsFromParsed(parsed)
      if (items && items.length > 0) {
        lastToolResultItems = items
      }
    }

    const stickySkillStore = {
      async getActiveSkill(sid: string): Promise<string | null> {
        const meta = await ctx.store.getSessionMeta(sid)
        const active = meta?.activeSkill
        return typeof active === 'string' && active.length > 0 ? active : null
      },
      async setActiveSkill(sid: string, skillName: string): Promise<void> {
        const existing = (await ctx.store.getSessionMeta(sid)) ?? {}
        await ctx.store.setSessionMeta(
          sid,
          { ...existing, activeSkill: skillName },
          ctx.sessionTtlSeconds,
        )
      },
    }

    // Cross-turn TodoWrite persistence. Reuses the same Redis-backed
    // sessionMeta plumbing as stickySkillStore, storing the list under
    // `meta.todos`. Without this the runner's per-turn appState reset
    // wipes out every `TodoWrite` call as soon as the turn ends.
    const todoStore = {
      async getTodos(sid: string) {
        const meta = await ctx.store.getSessionMeta(sid)
        const stored = (meta as any)?.todos
        return Array.isArray(stored) ? stored : null
      },
      async setTodos(sid: string, todos: any) {
        const existing = ((await ctx.store.getSessionMeta(sid)) ?? {}) as Record<string, unknown>
        await ctx.store.setSessionMeta(
          sid,
          ({ ...existing, todos } as unknown) as Record<string, string>,
          ctx.sessionTtlSeconds,
        )
      },
    }

    const abortController = new AbortController()
    const turnTimeoutMs = Number(process.env.ORB2_TURN_TIMEOUT_MS) || 180_000
    let turnTimedOut = false
    const turnTimeoutHandle = setTimeout(() => {
      turnTimedOut = true
      log.warn('rabbit.request.timeout', {
        correlationId: env.correlationId,
        sessionId,
        timeoutMs: turnTimeoutMs,
      })
      abortController.abort()
    }, turnTimeoutMs)

    try {
      const result = await runAgentTurn(
        {
          message: env.body.message,
          model,
          workingDirectory,
          previousMessages,
          signal: abortController.signal,
          autoApprove: () => true,
          mcpToken,
          sessionId,
          stickySkillStore,
          todoStore,
        },
        {
          onLog: (level, msg, data) => (log as any)[level]?.(msg, data),
          onTextChunk,
          onToolStart,
          onToolResult,
        },
      )
      clearTimeout(turnTimeoutHandle)

      if (turnTimedOut) {
        throw new Error(`agent turn exceeded ${turnTimeoutMs}ms timeout`)
      }

      await flushPendingChunk()

      // Review-summary fenced block detection: applies BEFORE the
      // hadToolCall branch so a confirm-gate response with no MCP tool
      // calls still routes through the widget pipeline.
      let finalMessageText = result.fullText
      const reviewSummary = tryExtractReviewSummary(result.fullText)
      if (reviewSummary) {
        lastWidgetName = 'review-summary'
        lastWidgetPayload = reviewSummary.payload
        finalMessageText = reviewSummary.cleanedText
        hadToolCall = true
      }

      // Strip duplicated inline list rendering from the agent's text
      // whenever items have been extracted from a tool result and will
      // be shown as a list widget. Without this, occasionally-non-
      // compliant skills duplicate the data inline and the UI shows
      // both an ugly text list AND the widget. We catch the three
      // shapes the agent typically produces:
      //   - GFM-style markdown tables (pipe header + --- separator).
      //   - Markdown bullet/numbered lists (>= 2 consecutive items).
      //   - Plain "Name — description" lines (>= 2 consecutive lines
      //     with em-dash or " - " separator and >= 4 chars after it).
      if (lastToolResultItems && !lastWidgetName) {
        let cleaned = finalMessageText

        // 1) Markdown tables.
        const tableBlock = /(?:^|\n)\s*\|.+\|\s*\n\s*\|[\s:|-]+\|\s*(?:\n\s*\|.+\|\s*)*/g
        cleaned = cleaned.replace(tableBlock, '\n')

        // 2) Markdown bullet / numbered lists (≥ 2 consecutive items).
        const bulletBlock = /(?:^|\n)(?:[ \t]*(?:[-*+•]|\d+\.)\s+.+(?:\n|$)){2,}/g
        cleaned = cleaned.replace(bulletBlock, '\n')

        // 3) "Name — description" / "Name - description" lines, ≥ 2 in a row.
        const dashBlock = /(?:^|\n)(?:[ \t]*[^\n]+?\s+(?:—|–|-)\s+[^\n]{4,}(?:\n|$)){2,}/g
        cleaned = cleaned.replace(dashBlock, '\n')

        cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim()
        if (cleaned !== finalMessageText) {
          log.info('rabbit.request.inline_list_stripped', {
            correlationId: env.correlationId,
            sessionId,
            originalLen: finalMessageText.length,
            strippedLen: cleaned.length,
          })
          finalMessageText = cleaned
        }
      }

      if (hadToolCall) {
        // Tool call(s) happened — let the agui widget resolver classify
        // the final response (e.g. workspace picker) and emit only the
        // widget events. The orchestrator will also send RUN_FINISHED,
        // closing the streamed text message. Forward the structured
        // tool output so the widget body has real data to render.
        if (streamStartPublished) {
          // Race: streaming had already begun before the tool call
          // started. Close the text bubble so the UI doesn't leave it
          // in a half-open state, then let the widget render below.
          await publishToFabric(
            buildResultEnvelope(
              env,
              { state: 'streaming', message: '', metadata: { streamPhase: 'end' } },
              'task.message.delta',
            ),
          )
        }
        const widgetMetadata: Record<string, unknown> = {
          session_id: sessionId,
          alreadyStreamed: true,
          usage: {
            prompt_tokens: result.promptTokens,
            completion_tokens: result.completionTokens,
          },
        }
        if (lastWidgetName && lastWidgetPayload) {
          widgetMetadata.widget = { name: lastWidgetName }
          widgetMetadata.responseData = { items: [lastWidgetPayload] }
        } else if (lastToolResultItems) {
          widgetMetadata.responseData = { items: lastToolResultItems }
        }

        await publishToFabric(
          buildResultEnvelope(
            env,
            {
              state: result.interrupted ? 'cancelled' : 'completed',
              message: finalMessageText,
              metadata: widgetMetadata,
            },
            'task.result.ready',
          ),
        )
      } else {
        // Pure text reply — close the streamed message ourselves.
        await publishToFabric(
          buildResultEnvelope(
            env,
            { state: 'streaming', message: '', metadata: { streamPhase: 'end' } },
            'task.message.delta',
          ),
        )
      }

      await ctx.store.setSession(sessionId, result.finalMessages, ctx.sessionTtlSeconds)

      log.info('rabbit.request.completed', {
        correlationId: env.correlationId,
        sessionId,
        prompt_tokens: result.promptTokens,
        completion_tokens: result.completionTokens,
      })

      return 'ack'
    } catch (err) {
      clearTimeout(turnTimeoutHandle)
      const message = (err as Error).message ?? 'agent run failed'
      log.error('rabbit.request.failed', {
        correlationId: env.correlationId,
        error: message,
        timedOut: turnTimedOut,
      })

      try {
        await flushPendingChunk()
        await publishToFabric(
          buildResultEnvelope(
            env,
            { state: 'streaming', message: `\n[error] ${message}`, metadata: { streamPhase: 'delta' } },
            'task.message.delta',
          ),
        )
        await publishToFabric(
          buildResultEnvelope(
            env,
            { state: 'streaming', message: '', metadata: { streamPhase: 'end' } },
            'task.message.delta',
          ),
        )
      } catch (publishErr) {
        log.error('rabbit.request.failed.publish_error', {
          correlationId: env.correlationId,
          error: (publishErr as Error).message,
        })
      }

      await publishToFabric(
        buildResultEnvelope(
          env,
          { state: 'failed', message, metadata: { error: message } },
          'task.failed',
        ),
      )

      // Acknowledge instead of requeue: the failure has been reported
      // back through the result queue, retrying would just duplicate.
      return 'ack'
    }
  })
}
