/**
 * Channel registration entry point. Registers all known channels into
 * the registry; startConfiguredChannels() then starts only those whose
 * credentials are present. Adding a channel = one import + one register.
 */
import { registerChannel, startConfiguredChannels } from './registry.js'
import { WhatsAppChannel } from './whatsapp.js'
import { TelegramChannel } from './telegram.js'
import { VoiceChannel } from './voice.js'
import type { Store } from '../store/store.js'

let registered = false

export function registerAllChannels(): void {
  if (registered) return
  registered = true
  registerChannel(new WhatsAppChannel())
  registerChannel(new TelegramChannel())
  registerChannel(new VoiceChannel())
}

export async function startChannels(store: Store): Promise<void> {
  registerAllChannels()
  await startConfiguredChannels(store)
}

export { listChannelStatus, getChannel } from './registry.js'
