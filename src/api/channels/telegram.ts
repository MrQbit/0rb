/**
 * Telegram channel via the Bot API (long-polling, no SDK dependency).
 *
 * Configure with:
 *   ORB2_TELEGRAM_BOT_TOKEN   bot token from @BotFather
 *   ORB2_TELEGRAM_OWNER_ID    numeric chat id of the owner (only this
 *                             chat is processed; others are ignored)
 *
 * Find your owner id by messaging the bot once and reading the log line
 * `telegram_message_from_unknown` which includes the chat id.
 */
import type { Channel, ChannelStatus } from './types.js'
import type { Store } from '../store/store.js'
import { runChannelTurn } from './runtime.js'
import { log } from '../log.js'

const API = 'https://api.telegram.org'
const SESSION_PREFIX = 'telegram:'

export class TelegramChannel implements Channel {
  readonly id = 'telegram'
  readonly name = 'Telegram'

  private store: Store | null = null
  private running = false
  private offset = 0
  private connected = false
  private lastMessageAt: string | null = null

  isConfigured(): boolean {
    return !!process.env.ORB2_TELEGRAM_BOT_TOKEN && !!process.env.ORB2_TELEGRAM_OWNER_ID
  }

  private token(): string {
    return process.env.ORB2_TELEGRAM_BOT_TOKEN || ''
  }

  private ownerId(): string {
    return String(process.env.ORB2_TELEGRAM_OWNER_ID || '')
  }

  async start(store: Store): Promise<void> {
    if (this.running) return
    this.store = store
    this.running = true

    // Verify the token before entering the poll loop.
    const me = await this.call('getMe').catch(() => null)
    if (!me?.ok) {
      this.running = false
      throw new Error('Telegram getMe failed — check ORB2_TELEGRAM_BOT_TOKEN')
    }
    this.connected = true
    log.info('telegram_connected', { bot: me.result?.username })
    void this.pollLoop()
  }

  async stop(): Promise<void> {
    this.running = false
    this.connected = false
  }

  getStatus(): ChannelStatus {
    return {
      id: this.id,
      name: this.name,
      configured: this.isConfigured(),
      connected: this.connected,
      detail: { lastMessageAt: this.lastMessageAt, ownerId: this.ownerId() || null },
    }
  }

  private async call(method: string, body?: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${API}/bot${this.token()}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    return res.json()
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const resp = await this.call('getUpdates', { offset: this.offset, timeout: 30 })
        if (!resp?.ok) {
          await sleep(2_000)
          continue
        }
        for (const update of resp.result as any[]) {
          this.offset = update.update_id + 1
          await this.handleUpdate(update)
        }
      } catch (err) {
        log.warn('telegram_poll_error', { error: (err as Error).message })
        await sleep(3_000)
      }
    }
  }

  private async handleUpdate(update: any): Promise<void> {
    const msg = update.message || update.edited_message
    const text: string = msg?.text || ''
    const chatId = String(msg?.chat?.id ?? '')
    if (!text || !chatId) return

    if (chatId !== this.ownerId()) {
      log.warn('telegram_message_from_unknown', { chatId })
      return
    }

    this.lastMessageAt = new Date().toISOString()
    log.info('telegram_message_received', { chatId, len: text.length })

    const reply = await runChannelTurn({
      text,
      sessionId: `${SESSION_PREFIX}${chatId}`,
      ownerId: `${SESSION_PREFIX}${chatId}`,
      store: this.store!,
    })

    if (reply.trim()) {
      // Telegram caps a message at 4096 chars; chunk long replies.
      for (const part of chunk(reply, 4000)) {
        await this.call('sendMessage', { chat_id: chatId, text: part }).catch(err =>
          log.error('telegram_send_failed', { error: (err as Error).message }),
        )
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function chunk(s: string, size: number): string[] {
  if (s.length <= size) return [s]
  const out: string[] = []
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size))
  return out
}
