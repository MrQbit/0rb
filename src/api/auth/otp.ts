/**
 * Email + one-time-code authentication for rak00n.
 *
 * Only addresses on an internal allowlist may sign in. A 6-digit code is
 * emailed to the address; verifying it issues the same signed session
 * token used elsewhere (see session.ts). No passwords.
 *
 * Allowlist resolves from the kv store (console-editable) then env:
 *   RAK00N_AUTH_ALLOWED_EMAILS   comma-separated bootstrap allowlist
 *
 * Email delivery uses SMTP via `curl` (no new dependency); configure:
 *   RAK00N_SMTP_HOST  RAK00N_SMTP_PORT(=465)  RAK00N_SMTP_USER  RAK00N_SMTP_PASS
 *   RAK00N_SMTP_FROM (defaults to USER)
 * When SMTP isn't configured, the code is written to the API log so the
 * flow is still testable (single-user box).
 */
import { randomInt, createHash, timingSafeEqual } from 'node:crypto'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Store } from '../store/store.js'
import { log } from '../log.js'

const OTP_PREFIX = 'otp:'
// Same kv key the Settings UI writes (PUT /v1/settings RAK00N_AUTH_ALLOWED_EMAILS),
// so the allowlist is editable from the console and takes effect immediately.
const ALLOWLIST_KEY = 'setting:RAK00N_AUTH_ALLOWED_EMAILS'
// The richer "database of allowed users" — each entry can carry a Telegram
// chat id so codes can be delivered over Telegram as well as email.
const USERS_KEY = 'auth:users'
const OTP_TTL_S = 600          // 10 minutes
const RESEND_COOLDOWN_MS = 30_000
const MAX_TRIES = 5
const LONG_TTL_S = 60 * 60 * 24 * 3650

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function normalizeEmail(e: string): string {
  return (e || '').trim().toLowerCase()
}

function envAllowed(): string[] {
  return (process.env.RAK00N_AUTH_ALLOWED_EMAILS || '')
    .split(',').map(normalizeEmail).filter(Boolean)
}

function parseList(s: string): string[] {
  return s.split(',').map(normalizeEmail).filter(Boolean)
}

export async function allowedEmails(store: Store): Promise<string[]> {
  const fromUsers = (await getUsers(store)).map(u => u.email)
  let legacy: string[] = []
  try {
    const raw = await store.getKv(ALLOWLIST_KEY)
    legacy = raw ? parseList(raw) : envAllowed()
  } catch { legacy = envAllowed() }
  return Array.from(new Set([...fromUsers, ...legacy]))
}

export async function setAllowedEmails(store: Store, emails: string[]): Promise<string[]> {
  const clean = Array.from(new Set(emails.map(normalizeEmail).filter(e => EMAIL_RE.test(e))))
  await store.putKv(ALLOWLIST_KEY, clean.join(','), LONG_TTL_S)
  return clean
}

export async function isAllowed(store: Store, email: string): Promise<boolean> {
  return (await allowedEmails(store)).includes(normalizeEmail(email))
}

// ───────────────────────── user database ─────────────────────────
// The allowlist as a richer record: per-user delivery channels. The flat
// RAK00N_AUTH_ALLOWED_EMAILS is still honoured (union) for back-compat.

export type AuthUser = {
  email: string
  telegram_chat_id?: string
  label?: string
  added_at: string
}

/**
 * Load the user database, seeding it on first use from the env/legacy
 * allowlist. The first seeded user is mapped to the owner's Telegram chat
 * (RAK00N_TELEGRAM_OWNER_ID) so Telegram-delivered codes work out of the box.
 */
export async function getUsers(store: Store): Promise<AuthUser[]> {
  try {
    const raw = await store.getKv(USERS_KEY)
    if (raw) {
      const arr = JSON.parse(raw) as AuthUser[]
      if (Array.isArray(arr) && arr.length) return arr
    }
  } catch { /* seed below */ }
  const ownerTg = String(process.env.RAK00N_TELEGRAM_OWNER_ID || '').trim()
  const seeded: AuthUser[] = envAllowed().map((email, i) => ({
    email,
    telegram_chat_id: i === 0 && ownerTg ? ownerTg : undefined,
    label: i === 0 ? 'owner' : undefined,
    added_at: new Date().toISOString(),
  }))
  if (seeded.length) await store.putKv(USERS_KEY, JSON.stringify(seeded), LONG_TTL_S).catch(() => {})
  return seeded
}

async function saveUsers(store: Store, users: AuthUser[]): Promise<AuthUser[]> {
  const clean = users
    .map(u => ({ ...u, email: normalizeEmail(u.email) }))
    .filter(u => EMAIL_RE.test(u.email))
  // De-dupe by email, last write wins.
  const byEmail = new Map(clean.map(u => [u.email, u]))
  const out = Array.from(byEmail.values())
  await store.putKv(USERS_KEY, JSON.stringify(out), LONG_TTL_S)
  // Keep the flat allowlist in sync so both views agree.
  await store.putKv(ALLOWLIST_KEY, out.map(u => u.email).join(','), LONG_TTL_S).catch(() => {})
  return out
}

export async function findUser(store: Store, email: string): Promise<AuthUser | null> {
  const e = normalizeEmail(email)
  return (await getUsers(store)).find(u => u.email === e) ?? null
}

export async function addUser(store: Store, u: { email: string; telegram_chat_id?: string; label?: string }): Promise<AuthUser[]> {
  const users = await getUsers(store)
  const email = normalizeEmail(u.email)
  const existing = users.find(x => x.email === email)
  if (existing) {
    if (u.telegram_chat_id !== undefined) existing.telegram_chat_id = String(u.telegram_chat_id).trim() || undefined
    if (u.label !== undefined) existing.label = u.label
  } else {
    users.push({ email, telegram_chat_id: u.telegram_chat_id ? String(u.telegram_chat_id).trim() : undefined, label: u.label, added_at: new Date().toISOString() })
  }
  return saveUsers(store, users)
}

export async function removeUser(store: Store, email: string): Promise<AuthUser[]> {
  const e = normalizeEmail(email)
  return saveUsers(store, (await getUsers(store)).filter(u => u.email !== e))
}

/** Which delivery channels are usable for this email right now. */
export async function availableChannels(store: Store, email: string): Promise<Array<'email' | 'telegram'>> {
  const out: Array<'email' | 'telegram'> = ['email']
  const u = await findUser(store, email)
  if (u?.telegram_chat_id && process.env.RAK00N_TELEGRAM_BOT_TOKEN) out.push('telegram')
  return out
}

function codeHash(email: string, code: string): string {
  return createHash('sha256')
    .update(`${email}:${code}:${process.env.RAK00N_AUTH_SECRET || ''}`)
    .digest('hex')
}

type OtpRecord = { hash: string; exp: number; tries: number; sentAt: number }

export type RequestOtpResult = { ok: boolean; sent: boolean; cooldown?: boolean; allowed: boolean }

/** Generate + send a code for an allowed email, via 'email' (default) or 'telegram'. */
export async function requestOtp(store: Store, emailRaw: string, via: 'email' | 'telegram' = 'email'): Promise<RequestOtpResult> {
  const email = normalizeEmail(emailRaw)
  if (!EMAIL_RE.test(email)) return { ok: false, sent: false, allowed: false }
  if (!(await isAllowed(store, email))) {
    log.warn('otp_request_denied', { email })
    return { ok: true, sent: false, allowed: false } // don't leak allowlist
  }

  // Light resend cooldown.
  try {
    const existing = await store.getKv(`${OTP_PREFIX}${email}`)
    if (existing) {
      const rec = JSON.parse(existing) as OtpRecord
      if (Date.now() - rec.sentAt < RESEND_COOLDOWN_MS) {
        return { ok: true, sent: true, cooldown: true, allowed: true }
      }
    }
  } catch { /* ignore */ }

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const rec: OtpRecord = { hash: codeHash(email, code), exp: Date.now() + OTP_TTL_S * 1000, tries: 0, sentAt: Date.now() }
  await store.putKv(`${OTP_PREFIX}${email}`, JSON.stringify(rec), OTP_TTL_S)

  let sent = false
  if (via === 'telegram') {
    const u = await findUser(store, email)
    if (u?.telegram_chat_id) sent = await sendCodeTelegram(u.telegram_chat_id, code)
    else log.warn('otp_telegram_no_chat', { email })
  } else {
    sent = await sendCodeEmail(email, code)
  }
  if (!sent) log.warn('otp_unsent_logging_code', { email, via, code, hint: 'configure RAK00N_SMTP_* / map a Telegram chat id to deliver codes' })
  return { ok: true, sent, allowed: true }
}

/** Deliver a code over Telegram to a mapped chat id. */
async function sendCodeTelegram(chatId: string, code: string): Promise<boolean> {
  const token = process.env.RAK00N_TELEGRAM_BOT_TOKEN
  if (!token) return false
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: `🔐 Your rak00n sign-in code is ${code}\n\nIt expires in 10 minutes. If you didn't request it, ignore this message.` }),
    })
    if (!res.ok) { log.error('otp_telegram_failed', { status: res.status, body: (await res.text()).slice(0, 160) }); return false }
    log.info('otp_telegram_sent', { chatId })
    return true
  } catch (err) {
    log.error('otp_telegram_error', { error: (err as Error).message })
    return false
  }
}

/** Verify a code; returns the email on success, else null. */
export async function verifyOtp(store: Store, emailRaw: string, code: string): Promise<string | null> {
  const email = normalizeEmail(emailRaw)
  const raw = await store.getKv(`${OTP_PREFIX}${email}`)
  if (!raw) return null
  let rec: OtpRecord
  try { rec = JSON.parse(raw) as OtpRecord } catch { return null }
  if (Date.now() > rec.exp || rec.tries >= MAX_TRIES) {
    await store.delKv(`${OTP_PREFIX}${email}`)
    return null
  }
  const expected = Buffer.from(rec.hash, 'hex')
  const got = Buffer.from(codeHash(email, (code || '').trim()), 'hex')
  if (expected.length === got.length && timingSafeEqual(expected, got)) {
    await store.delKv(`${OTP_PREFIX}${email}`)
    return email
  }
  rec.tries += 1
  const remainingMs = Math.max(1, rec.exp - Date.now())
  await store.putKv(`${OTP_PREFIX}${email}`, JSON.stringify(rec), Math.ceil(remainingMs / 1000))
  return null
}

// ─────────────────────────── email (SMTP via curl) ───────────────────────────

async function sendCodeEmail(to: string, code: string): Promise<boolean> {
  const host = process.env.RAK00N_SMTP_HOST
  const user = process.env.RAK00N_SMTP_USER
  const pass = process.env.RAK00N_SMTP_PASS
  if (!host || !user || !pass) return false
  const port = process.env.RAK00N_SMTP_PORT || '465'
  const from = process.env.RAK00N_SMTP_FROM || user

  const message =
    `From: rak00n <${from}>\r\n` +
    `To: ${to}\r\n` +
    `Subject: Your rak00n sign-in code: ${code}\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
    `Your rak00n sign-in code is ${code}\r\n\r\nIt expires in 10 minutes. If you didn't request it, ignore this email.\r\n`

  const file = join(tmpdir(), `rak-otp-${Date.now()}.eml`)
  try {
    writeFileSync(file, message)
    const proc = Bun.spawn([
      'curl', '--silent', '--show-error', '--ssl-reqd',
      '--url', `smtps://${host}:${port}`,
      '--user', `${user}:${pass}`,
      '--mail-from', from,
      '--mail-rcpt', to,
      '--upload-file', file,
    ], { stdout: 'pipe', stderr: 'pipe' })
    await proc.exited
    if (proc.exitCode !== 0) {
      log.error('otp_smtp_failed', { stderr: (await new Response(proc.stderr).text()).slice(0, 200) })
      return false
    }
    log.info('otp_email_sent', { to })
    return true
  } catch (err) {
    log.error('otp_smtp_error', { error: (err as Error).message })
    return false
  } finally {
    try { rmSync(file, { force: true }) } catch { /* ignore */ }
  }
}
