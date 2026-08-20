/**
 * Human summaries + inverse capture for the trust layer. Summaries are what
 * receipts and approval cards say; inverses are captured BEFORE execution so
 * "undo" restores the prior state, not a guess.
 */
import type { Store } from '../store/store.js'
import type { Inverse } from './policy.js'

export function summarizeAction(tool: string, args: any): string {
  const op = String(args?.op || '')
  const q = String(args?.query || args?.device || args?.printer || '')
  switch (tool) {
    case 'Home':
      if (op === 'mode') return `Set the house to ${args?.mode}${args?.secure ? ' and secure it' : ''}`
      if (op === 'control' || args?.action) return `${cap(String(args?.action || 'change'))} ${q || 'a device'}${args?.value != null ? ` to ${args.value}` : ''}`
      return `Home ${op}`
    case 'AirPlay':
      if (op === 'say') return `Announce on ${q || 'a speaker'}: “${String(args?.text || '').slice(0, 60)}”`
      if (op === 'play') return `Play audio on ${q || 'a speaker'}`
      if (op === 'volume') return `Set ${q || 'speaker'} volume to ${args?.level}`
      if (op === 'stop') return `Stop playback on ${q || 'a speaker'}`
      return `AirPlay ${op}`
    case 'Print': return `Print ${args?.file ? String(args.file) : 'a note'} on ${q || 'the printer'}`
    case 'HomeAdmin':
      if (op === 'automate') return `Create automation “${String(args?.name || args?.description || 'unnamed').slice(0, 50)}”`
      if (op === 'pair' || op === 'setup') return `Set up ${args?.integration || 'a device'} in Home Assistant`
      return `Home admin: ${op}`
    case 'Timer': return op === 'cancel' ? 'Cancel a timer' : `Set a timer${args?.minutes ? ` for ${args.minutes} min` : ''}`
    case 'Settings': return `Change setting ${args?.key || ''}`
    case 'Shopping': return `Shopping list: ${op || 'update'}`
    default: return `${tool}${op ? ` ${op}` : ''}`
  }
}

function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1) }

/** Prior-state inverse for Home actions; undefined when not derivable. */
export async function captureInverse(store: Store, tool: string, args: any): Promise<Inverse | undefined> {
  try {
    if (tool !== 'Home') return undefined
    if (String(args?.op) === 'mode' && args?.mode) {
      const { getMode } = await import('../home/mode.js')
      const prior = await getMode(store)
      return prior && prior !== args.mode ? { kind: 'mode', mode: prior } : undefined
    }
    const action = String(args?.action || '')
    if (!['on', 'off', 'toggle', 'set'].includes(action)) return undefined
    const q = String(args?.query || '').trim()
    if (!q) return undefined
    const { haStates, haResolve, haJoinAreas, HOME_DOMAINS } = await import('../connectors/homeAssistant.js')
    const matches = haResolve(await haJoinAreas(await haStates(HOME_DOMAINS)), q)
    if (matches.length !== 1) return undefined     // ambiguous → no inverse
    const e = matches[0]!
    if (!['light', 'switch', 'fan', 'media_player'].includes(e.domain)) return undefined
    if (e.state === 'on' || e.state === 'playing') {
      const b = e.attributes.brightness
      const pct = typeof b === 'number' ? Math.round((b / 255) * 100) : undefined
      return { kind: 'home-control', entity_id: e.entity_id, action: 'on', value: pct }
    }
    return { kind: 'home-control', entity_id: e.entity_id, action: 'off' }
  } catch { return undefined }
}
