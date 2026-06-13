/**
 * WhatsApp channel adapter — wraps the existing Baileys bridge in the
 * Channel interface so it lives in the unified registry alongside
 * Telegram/etc. Message handling routes through the shared
 * runChannelTurn so WhatsApp-driven turns get the API-native tools.
 */
import type { Channel, ChannelStatus } from './types.js'
import type { Store } from '../store/store.js'
import { runChannelTurn } from './runtime.js'
import { WhatsAppBridge } from '../whatsapp/bridge.js'
import { log } from '../log.js'

const SESSION_PREFIX = 'whatsapp:'

export class WhatsAppChannel implements Channel {
  readonly id = 'whatsapp'
  readonly name = 'WhatsApp'

  private bridge: WhatsAppBridge | null = null

  isConfigured(): boolean {
    return !!process.env.ORB2_OWNER_PHONE
  }

  async start(store: Store): Promise<void> {
    if (this.bridge) return
    const ownerPhone = (process.env.ORB2_OWNER_PHONE || '').replace(/^\+/, '').replace(/\D/g, '')
    const bridge = new WhatsAppBridge(store)
    this.bridge = bridge

    bridge.on('message', async ({ text }: { text: string }) => {
      const reply = await runChannelTurn({
        text,
        sessionId: `${SESSION_PREFIX}${ownerPhone}`,
        ownerId: `${SESSION_PREFIX}${ownerPhone}`,
        store,
      })
      if (reply.trim()) {
        try {
          await bridge.sendMessage(ownerPhone, reply)
        } catch (err) {
          log.error('whatsapp_reply_failed', { error: (err as Error).message })
        }
      }
    })

    await bridge.connect()
  }

  async stop(): Promise<void> {
    await this.bridge?.disconnect().catch(() => {})
    this.bridge = null
  }

  getBridge(): WhatsAppBridge | null {
    return this.bridge
  }

  getStatus(): ChannelStatus {
    const s = this.bridge?.getStatus()
    return {
      id: this.id,
      name: this.name,
      configured: this.isConfigured(),
      connected: !!s?.connected,
      detail: s
        ? { phone: s.phone, qr_available: s.qr_available, lastMessageAt: s.lastMessageAt }
        : { qr_available: false },
    }
  }
}
