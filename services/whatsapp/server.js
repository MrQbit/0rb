/**
 * orb2 WhatsApp bridge (OpenClaw-style).
 *
 * Links the owner's own WhatsApp account via a QR scan (WhatsApp Web), then
 * relays messages from ALLOWED numbers to the orb2 agent and sends the
 * reply back over WhatsApp. Register only your own number and you can chat
 * with yourself — the agent answers.
 *
 * Why a separate service: Baileys is a heavy native-ish lib that doesn't
 * bundle into the agent's single-file Bun image, so it lives here (a normal
 * Node container with node_modules) and bridges to orb2-api over HTTP —
 * mirroring the tts/stt/vision/embed service pattern.
 *
 * Env:
 *   ORB2_API_URL                 orb2-api base (default http://orb2-api:8080)
 *   ORB2_WHATSAPP_ALLOWED        comma-separated E.164 numbers allowed to text
 *   ORB2_WHATSAPP_BRIDGE_SECRET  shared secret for the inbound webhook
 *   WA_AUTH_DIR                  auth-state dir (default /wa-auth)
 *   PORT                         http port (default 8995)
 *
 * HTTP: GET /health, GET /status, GET /qr (PNG while unlinked).
 */
import { createServer } from 'node:http'
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys'
import QRCode from 'qrcode'
import qrTerminal from 'qrcode-terminal'
import pino from 'pino'

const log = pino({ level: process.env.LOG_LEVEL || 'info' })

const API_URL = (process.env.ORB2_API_URL || 'http://orb2-api:8080').replace(/\/+$/, '')
const BRIDGE_SECRET = process.env.ORB2_WHATSAPP_BRIDGE_SECRET || ''
const AUTH_DIR = process.env.WA_AUTH_DIR || '/wa-auth'
const PORT = Number(process.env.PORT || 8995)

function normNum(s) { return String(s || '').replace(/[^\d]/g, '') }
const ALLOWED = new Set(
  (process.env.ORB2_WHATSAPP_ALLOWED || '')
    .split(',').map(normNum).filter(Boolean),
)

let sock = null
let qrPng = null          // Buffer of the current QR (until linked)
let qrString = null
let connected = false
let meNumber = null
let lastMessageAt = null

async function relayToAgent(from, text) {
  const res = await fetch(`${API_URL}/v1/channels/whatsapp/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-secret': BRIDGE_SECRET },
    body: JSON.stringify({ from, text }),
  })
  if (!res.ok) throw new Error(`api inbound http ${res.status}`)
  const data = await res.json()
  return (data && data.reply) || ''
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }))

  sock = makeWASocket({ version, auth: state, browser: ['orb2', 'Chrome', '1.0'] })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u
    if (qr) {
      qrString = qr
      try { qrPng = await QRCode.toBuffer(qr, { width: 384, margin: 2 }) } catch { /* */ }
      log.info('QR ready — scan it from WhatsApp ▸ Linked devices ▸ Link a device:')
      qrTerminal.generate(qr, { small: true })
      log.info(`(or open http://<host>:${PORT}/qr for a PNG)`)
    }
    if (connection === 'open') {
      connected = true; qrPng = null; qrString = null
      meNumber = normNum(sock?.user?.id?.split(':')[0] || sock?.user?.id || '')
      log.info({ me: meNumber }, 'WhatsApp linked ✓')
    }
    if (connection === 'close') {
      connected = false
      const code = lastDisconnect?.error?.output?.statusCode
      const loggedOut = code === DisconnectReason.loggedOut
      log.warn({ code, loggedOut }, 'WhatsApp connection closed')
      if (!loggedOut) setTimeout(() => start().catch(e => log.error(e, 'reconnect failed')), 2500)
    }
  })

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages?.[0]
    if (!msg || msg.key?.fromMe || m.type !== 'notify') return
    const jid = msg.key?.remoteJid || ''
    if (jid.endsWith('@g.us')) return // ignore groups
    const from = normNum(jid)
    if (ALLOWED.size && !ALLOWED.has(from)) {
      log.warn({ from }, 'message from non-allowed number ignored')
      return
    }
    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption || ''
    if (!text.trim()) return
    lastMessageAt = new Date().toISOString()
    log.info({ from, len: text.length }, 'message received')
    try {
      await sock.sendPresenceUpdate('composing', jid)
      const reply = await relayToAgent(from, text)
      if (reply.trim()) await sock.sendMessage(jid, { text: reply })
    } catch (err) {
      log.error({ err: err.message }, 'relay/reply failed')
      try { await sock.sendMessage(jid, { text: `⚠️ ${err.message}` }) } catch { /* */ }
    }
  })
}

// ── tiny HTTP surface for health / status / QR ──
createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}') }
  if (req.url === '/status') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ connected, me: meNumber, allowed: [...ALLOWED], qr_available: !!qrPng, lastMessageAt }))
  }
  if (req.url === '/qr') {
    if (connected) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"connected":true}') }
    if (!qrPng) { res.writeHead(202, { 'content-type': 'application/json' }); return res.end('{"qr_available":false}') }
    res.writeHead(200, { 'content-type': 'image/png' }); return res.end(qrPng)
  }
  res.writeHead(404); res.end()
}).listen(PORT, () => log.info({ port: PORT, allowed: [...ALLOWED] }, 'whatsapp bridge http up'))

start().catch(e => { log.error(e, 'fatal'); process.exit(1) })
