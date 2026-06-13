/**
 * Channel abstraction (OpenClaw-style multi-channel control).
 *
 * A Channel is a remote-control surface (WhatsApp, Telegram, Discord,
 * Slack, ...) that delivers owner messages to the agent and sends the
 * reply back. Channels are LAZY: they only start when their credential
 * env var is present (isConfigured()), so an unconfigured channel costs
 * nothing and never blocks boot.
 */
import type { Store } from '../store/store.js'

export type ChannelStatus = {
  id: string
  name: string
  /** Credentials present in env — the channel will attempt to run. */
  configured: boolean
  /** Live connection established. */
  connected: boolean
  /** Optional channel-specific detail (linked account, QR availability). */
  detail?: Record<string, unknown>
}

export interface Channel {
  readonly id: string
  readonly name: string
  /** True when the env credentials for this channel are present. */
  isConfigured(): boolean
  /** Begin listening for owner messages. Idempotent. */
  start(store: Store): Promise<void>
  /** Stop listening and release resources. */
  stop(): Promise<void>
  getStatus(): ChannelStatus
}
