/**
 * App groups (Profiles v2): the owner-facing permission surface. Owners
 * toggle APPS per member, not raw tool names — each group maps to the
 * agent tools it covers. Tools not listed here are core and always on.
 * Owners themselves can never be restricted.
 */
export const APP_GROUPS: Record<string, { label: string; desc: string; tools: string[] }> = {
  shopping: { label: 'Shopping & purchases', desc: 'shopping list, payment methods', tools: ['Shopping', 'Wallet'] },
  commerce: { label: 'Ordering & spending', desc: 'food delivery, rides, buying things', tools: ['Order', 'Ride'] },
  music: { label: 'Music & video', desc: 'Spotify, YouTube, speakers', tools: ['MusicSearch', 'MusicPlay', 'MusicControl', 'YouTubeSearch', 'AirPlay'] },
  home: { label: 'Home control', desc: 'lights, locks, devices, house modes', tools: ['Home', 'HomeAdmin'] },
  web: { label: 'Web & news', desc: 'internet search, headlines', tools: ['WebSearch', 'NewsSearch'] },
  memory: { label: 'Memory & files', desc: 'household memory, documents, cloud files', tools: ['RecallMemory', 'VaultRead', 'VaultWrite', 'VaultSearch', 'CloudStorageSearch', 'CloudStoragePull'] },
  routines: { label: 'Routines & timers', desc: 'scheduled agents, timers', tools: ['Routines', 'Timer'] },
  system: { label: 'System & advanced', desc: "orb settings, code, publishing — usually owner territory", tools: ['Settings', 'Docker', 'DockerOps', 'ClusterOps', 'SelfEvolve', 'SelfUpdate', 'SelfBuild', 'SubmitJob', 'RunCode', 'Publish', 'CreateWidget', 'Blender'] },
}

const toolIndex = new Map<string, string>()
for (const [id, g] of Object.entries(APP_GROUPS)) for (const t of g.tools) toolIndex.set(t, id)

/** Which app group a tool belongs to (undefined = core, never restricted). */
export function appOf(tool: string): string | undefined {
  return toolIndex.get(tool)
}

/** The graceful refusal the agent relays when an app is off for a member. */
export function disabledMessage(tool: string): string {
  const id = appOf(tool)
  const label = id ? APP_GROUPS[id]!.label : tool
  return `“${label}” is turned off for this member's profile. Explain this kindly — the owner can switch it back on in Settings → Users → their profile.`
}
