/**
 * Server-Sent Events helper.
 *
 * Both Bun.serve and Node http.IncomingMessage support response
 * streams; this module produces a `ReadableStream` of `Uint8Array`
 * SSE frames so the request handler can `return new Response(stream,
 * {...})` from either runtime.
 *
 * SSE frame format (rfc-eventsource):
 *   event: <name>\n
 *   data: <json>\n\n
 */
const ENC = new TextEncoder()

export type SseHandle = {
  /** Send an event. Returns false if the underlying client closed. */
  send: (eventName: string, data: unknown) => boolean
  /** Close the stream cleanly. */
  close: () => void
  readable: ReadableStream<Uint8Array>
}

export function createSse(opts?: {
  /** Heartbeat interval in ms (sent as a comment). 0 disables. */
  heartbeatMs?: number
  /** Called when the consumer disconnects. */
  onAbort?: () => void
}): SseHandle {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  let closed = false
  let heartbeat: ReturnType<typeof setInterval> | null = null

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      // 5s default keeps the stream alive past Bun's 10s idleTimeout
      // and any intermediate proxy idle window. Override per-call if
      // a stream is known to produce events at a faster cadence.
      const interval = opts?.heartbeatMs ?? 5000
      if (interval > 0) {
        heartbeat = setInterval(() => {
          if (closed || !controller) return
          try {
            controller.enqueue(ENC.encode(`: hb\n\n`))
          } catch {
            // ignore — stream tearing down
          }
        }, interval)
      }
    },
    cancel() {
      closed = true
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = null
      controller = null
      opts?.onAbort?.()
    },
  })

  function send(eventName: string, data: unknown): boolean {
    if (closed || !controller) return false
    try {
      const payload =
        typeof data === 'string' ? data : JSON.stringify(data ?? null)
      const frame = eventName
        ? `event: ${eventName}\ndata: ${payload}\n\n`
        : `data: ${payload}\n\n`
      controller.enqueue(ENC.encode(frame))
      return true
    } catch {
      closed = true
      return false
    }
  }

  function close() {
    if (closed) return
    closed = true
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
    try {
      controller?.close()
    } catch {
      // ignore
    }
    controller = null
  }

  return { send, close, readable: stream }
}

export const SSE_RESPONSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no', // disable nginx buffering
}
