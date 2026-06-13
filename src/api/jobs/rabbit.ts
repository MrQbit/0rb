import type { FabricMessageEnvelope } from './types.js'

let _connection: any = null
let _channel: any = null
let _amqplib: any = null

async function getAmqplib() {
  if (_amqplib) return _amqplib
  try {
    _amqplib = await import('amqplib')
    return _amqplib
  } catch {
    return null
  }
}

function getUrl(): string {
  return process.env.RABBITMQ_URL || ''
}

function getOutputQueue(): string {
  return process.env.RABBITMQ_OUTPUT_QUEUE || 'rakoon.jobs.output'
}

function getInputQueue(): string {
  return process.env.RABBITMQ_INPUT_QUEUE || 'fabric.agents.requests'
}

function getInputDlqQueue(): string {
  return `${getInputQueue()}.dlq`
}

export type ConsumeHandler = (
  envelope: unknown,
  raw: Buffer,
) => Promise<'ack' | 'requeue' | 'reject'>

export async function connectRabbit(): Promise<boolean> {
  const url = getUrl()
  if (!url) {
    console.log('[rabbit] RABBITMQ_URL not set, RabbitMQ disabled')
    return false
  }

  const amqp = await getAmqplib()
  if (!amqp) {
    console.warn('[rabbit] amqplib not available, RabbitMQ disabled')
    return false
  }

  try {
    _connection = await amqp.connect(url)
    _channel = await _connection.createChannel()
    const queue = getOutputQueue()
    await _channel.assertQueue(queue, { durable: true })
    console.log(`[rabbit] Connected to RabbitMQ, output queue: ${queue}`)

    _connection.on('close', () => {
      console.warn('[rabbit] Connection closed, will reconnect on next publish')
      _connection = null
      _channel = null
    })
    _connection.on('error', (err: Error) => {
      console.error('[rabbit] Connection error:', err.message)
      _connection = null
      _channel = null
    })

    return true
  } catch (err) {
    console.error('[rabbit] Failed to connect:', (err as Error).message)
    _connection = null
    _channel = null
    return false
  }
}

export async function disconnectRabbit(): Promise<void> {
  try {
    if (_channel) await _channel.close()
    if (_connection) await _connection.close()
  } catch { /* ignore */ }
  _channel = null
  _connection = null
}

export async function publishToFabric(envelope: FabricMessageEnvelope): Promise<boolean> {
  if (!_channel) {
    const connected = await connectRabbit()
    if (!connected) return false
  }

  try {
    const queue = getOutputQueue()
    const buf = Buffer.from(JSON.stringify(envelope))
    _channel.sendToQueue(queue, buf, {
      persistent: true,
      contentType: 'application/json',
      messageId: envelope.messageId,
      correlationId: envelope.correlationId,
      timestamp: Math.floor(Date.now() / 1000),
      headers: { source: 'orb2-api' },
    })
    console.log(`[rabbit] Published message ${envelope.messageId} (${envelope.messageType}) to ${queue}`)
    return true
  } catch (err) {
    console.error('[rabbit] Publish failed:', (err as Error).message)
    _channel = null
    return false
  }
}

export function isRabbitConnected(): boolean {
  return _channel !== null
}

/**
 * Subscribe to the input queue and invoke `handler` for each delivery.
 *
 * Handler return values:
 *   - 'ack'     -> message acknowledged, removed from queue
 *   - 'requeue' -> nack with requeue=true (transient failure, redelivered)
 *   - 'reject'  -> nack with requeue=false; message routed to DLQ
 *
 * Idempotent: calling more than once registers an additional consumer
 * on the same channel, which is harmless but wasteful. Callers should
 * call once at startup.
 */
export async function consumeFromInputQueue(handler: ConsumeHandler): Promise<boolean> {
  if (!_channel) {
    const connected = await connectRabbit()
    if (!connected) return false
  }

  const queue = getInputQueue()
  const dlq = getInputDlqQueue()

  try {
    await _channel.assertQueue(dlq, { durable: true })
    await _channel.assertQueue(queue, { durable: true })
    await _channel.prefetch(1)

    await _channel.consume(
      queue,
      async (msg: any) => {
        if (!msg) return
        let envelope: unknown
        try {
          envelope = JSON.parse(msg.content.toString('utf8'))
        } catch (err) {
          console.error('[rabbit] consumer: malformed JSON, routing to DLQ:', (err as Error).message)
          _channel.sendToQueue(dlq, msg.content, { persistent: true, headers: { reason: 'malformed_json' } })
          _channel.ack(msg)
          return
        }

        try {
          const decision = await handler(envelope, msg.content)
          if (decision === 'ack') {
            _channel.ack(msg)
          } else if (decision === 'requeue') {
            _channel.nack(msg, false, true)
          } else {
            _channel.sendToQueue(dlq, msg.content, {
              persistent: true,
              headers: { reason: 'handler_reject' },
            })
            _channel.ack(msg)
          }
        } catch (err) {
          console.error('[rabbit] consumer handler threw, routing to DLQ:', (err as Error).message)
          _channel.sendToQueue(dlq, msg.content, {
            persistent: true,
            headers: { reason: 'handler_exception', error: (err as Error).message },
          })
          _channel.ack(msg)
        }
      },
      { noAck: false },
    )

    console.log(`[rabbit] Consumer registered on ${queue} (DLQ: ${dlq})`)
    return true
  } catch (err) {
    console.error('[rabbit] Failed to start consumer:', (err as Error).message)
    return false
  }
}
