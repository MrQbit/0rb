/**
 * Channel registry. Holds the set of known channels and starts the ones
 * whose credentials are configured. All start failures are non-fatal —
 * a remote-control channel must never block or crash the API.
 */
import type { Channel, ChannelStatus } from './types.js'
import type { Store } from '../store/store.js'
import { log } from '../log.js'

const channels = new Map<string, Channel>()

export function registerChannel(channel: Channel): void {
  channels.set(channel.id, channel)
}

export function getChannel(id: string): Channel | undefined {
  return channels.get(id)
}

export function listChannelStatus(): ChannelStatus[] {
  return [...channels.values()].map(c => c.getStatus())
}

/**
 * Start every configured channel. Fire-and-forget per channel so one
 * slow/failed channel cannot delay the others or boot.
 */
export async function startConfiguredChannels(store: Store): Promise<void> {
  for (const channel of channels.values()) {
    if (!channel.isConfigured()) {
      log.info('channel_skipped', { id: channel.id, reason: 'not configured' })
      continue
    }
    void (async () => {
      try {
        await channel.start(store)
        log.info('channel_started', { id: channel.id })
      } catch (err) {
        log.warn('channel_start_failed', { id: channel.id, error: (err as Error).message })
      }
    })()
  }
}

export async function stopAllChannels(): Promise<void> {
  for (const channel of channels.values()) {
    try { await channel.stop() } catch { /* ignore */ }
  }
}

/**
 * Stop all running channels and restart those that are now configured.
 * Called after settings change so channels pick up new env vars without
 * requiring a pod restart.
 */
export async function restartChannels(store: Store): Promise<void> {
  log.info('channels_restarting', { count: channels.size })
  await stopAllChannels()
  await startConfiguredChannels(store)
}
