/**
 * WhatsApp bridge via @whiskeysockets/baileys.
 * Connects to WhatsApp, persists credentials in the store, and emits
 * incoming messages from the owner phone.
 *
 * Only messages from ORB2_OWNER_PHONE (E.164 format) are processed.
 * The QR code is available at getQR() until the connection is established.
 */
import { EventEmitter } from 'node:events'
import type { Store } from '../store/store.js'
import { log } from '../log.js'

const CREDS_KEY = 'orb2:whatsapp:creds'
const QR_REFRESH_MS = 20_000

export type WaBridgeStatus = {
  connected: boolean
  phone: string | null
  lastMessageAt: string | null
  qr_available: boolean
}

export class WhatsAppBridge extends EventEmitter {
  private store: Store
  private socket: any = null
  private status: WaBridgeStatus = { connected: false, phone: null, lastMessageAt: null, qr_available: false }
  private currentQr: string | null = null
  private qrBuffer: Buffer | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 2_000

  constructor(store: Store) {
    super()
    this.store = store
  }

  async connect(): Promise<void> {
    const ownerPhone = process.env.ORB2_OWNER_PHONE
    if (!ownerPhone) {
      log.warn('whatsapp_no_owner_phone', { msg: 'ORB2_OWNER_PHONE not set; WhatsApp bridge disabled' })
      return
    }

    let makeWASocket: any, useInMemoryKeyStore: any, DisconnectReason: any
    try {
      const baileys = await import('@whiskeysockets/baileys' as any)
      makeWASocket = baileys.default?.makeWASocket || baileys.makeWASocket
      useInMemoryKeyStore = baileys.default?.makeInMemoryStore || baileys.makeInMemoryStore
      DisconnectReason = baileys.default?.DisconnectReason || baileys.DisconnectReason
    } catch (err) {
      log.warn('whatsapp_baileys_missing', { error: (err as Error).message })
      return
    }

    const savedCredsRaw = await this.store.getKv(CREDS_KEY).catch(() => null)
    const state: any = { creds: savedCredsRaw ? JSON.parse(savedCredsRaw) : undefined, keys: {} }

    this.socket = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      browser: ['orb2', 'Chrome', '1.0'],
    })

    this.socket.ev.on('creds.update', async (creds: any) => {
      // Long TTL — WhatsApp pairing creds should persist indefinitely.
      await this.store.putKv(CREDS_KEY, JSON.stringify(creds), 60 * 60 * 24 * 3650).catch(() => {})
    })

    this.socket.ev.on('connection.update', async (update: any) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        this.currentQr = qr
        this.status.qr_available = true
        await this.renderQr(qr)
        log.info('whatsapp_qr_ready', {})
      }

      if (connection === 'open') {
        this.status.connected = true
        this.status.qr_available = false
        this.currentQr = null
        this.qrBuffer = null
        this.reconnectDelay = 2_000
        log.info('whatsapp_connected', {})
        this.emit('connected')
      }

      if (connection === 'close') {
        this.status.connected = false
        const statusCode = lastDisconnect?.error?.output?.statusCode
        const loggedOut = statusCode === DisconnectReason?.loggedOut
        log.warn('whatsapp_disconnected', { statusCode, loggedOut })
        if (!loggedOut) {
          this.scheduleReconnect()
        }
        this.emit('disconnected', { loggedOut })
      }
    })

    this.socket.ev.on('messages.upsert', (m: any) => {
      const msg = m.messages?.[0]
      if (!msg || msg.key?.fromMe) return

      const from = (msg.key?.remoteJid || '').replace(/@.+$/, '')
      const ownerNum = ownerPhone.replace(/^\+/, '').replace(/\D/g, '')
      if (!from.startsWith(ownerNum)) return

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        ''

      if (!text) return

      this.status.lastMessageAt = new Date().toISOString()
      log.info('whatsapp_message_received', { from })
      this.emit('message', { text, from, raw: msg })
    })
  }

  private async renderQr(qr: string): Promise<void> {
    try {
      const qrcode = await import('qrcode' as any)
      this.qrBuffer = await qrcode.default.toBuffer(qr, { type: 'png', width: 300 })
    } catch {
      this.qrBuffer = null
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    const delay = Math.min(this.reconnectDelay, 60_000)
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000)
    log.info('whatsapp_reconnect_scheduled', { delayMs: delay })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect().catch(err => log.error('whatsapp_reconnect_failed', { error: (err as Error).message }))
    }, delay)
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    try {
      await this.socket?.logout()
    } catch { /* ignore */ }
    this.socket = null
    this.status.connected = false
    this.status.qr_available = false
    await this.store.delKv(CREDS_KEY).catch(() => {})
    log.info('whatsapp_disconnected_manual', {})
  }

  async sendMessage(to: string, text: string): Promise<void> {
    if (!this.socket || !this.status.connected) throw new Error('WhatsApp not connected')
    const jid = to.startsWith('+') ? `${to.slice(1)}@s.whatsapp.net` : `${to}@s.whatsapp.net`
    await this.socket.sendMessage(jid, { text })
  }

  getStatus(): WaBridgeStatus {
    return { ...this.status }
  }

  getQrBuffer(): Buffer | null {
    return this.qrBuffer
  }
}
