/**
 * In-process discovery registry. Holds the union of all scanned
 * repos' skills, agents and MCP servers, plus per-source freshness
 * metadata. Refreshed on startup, periodically, and on-demand via
 * POST /v1/discover/refresh.
 *
 * Conflict policy: discovered entries yield to local definitions.
 * The merge happens at consumption time -- this module just holds
 * raw discovery state.
 */
import { basename } from 'node:path'
import { getDiscoveryConfig, isDiscoveryEnabled, type DiscoverySource } from './config.js'
import { ensureRepo } from './gitFetcher.js'
import {
  scanRepo,
  type DiscoveredAgent,
  type DiscoveredMcp,
  type DiscoveredSkill,
  type ScanResult,
} from './scanner.js'

export type RepoStatus = {
  source: DiscoverySource
  source_repo: string
  ok: boolean
  error?: string
  last_refreshed_at?: string
  counts: { skills: number; agents: number; mcps: number; errors: number }
}

type RegistryState = {
  repos: RepoStatus[]
  skills: DiscoveredSkill[]
  agents: DiscoveredAgent[]
  mcps: DiscoveredMcp[]
  lastRefreshedAt?: string
}

let state: RegistryState = { repos: [], skills: [], agents: [], mcps: [] }
let refreshing = false
let refreshTimer: NodeJS.Timeout | null = null

function labelFor(source: DiscoverySource): string {
  if (source.kind === 'path') {
    const last = basename(source.path)
    return last || 'local'
  }
  // git URL: take the last path segment (repo name) without .git
  const url = source.url
  const m = url.match(/[/:]([^/:]+?)(?:\.git)?\/?$/)
  return m?.[1] || 'remote'
}

async function refreshOne(source: DiscoverySource): Promise<RepoStatus> {
  const cfg = getDiscoveryConfig()
  const sourceLabel = labelFor(source)
  let path: string
  try {
    if (source.kind === 'path') {
      path = source.path
    } else {
      const r = await ensureRepo(source.url, cfg.cacheRoot)
      if (!r.ok) {
        return {
          source, source_repo: sourceLabel, ok: false, error: (r as any).error,
          counts: { skills: 0, agents: 0, mcps: 0, errors: 1 },
        }
      }
      path = r.path
    }
  } catch (err) {
    return {
      source, source_repo: sourceLabel, ok: false, error: (err as Error).message,
      counts: { skills: 0, agents: 0, mcps: 0, errors: 1 },
    }
  }
  const scan: ScanResult = scanRepo(path, sourceLabel)
  // Merge into global registry. Replace any prior entries from this source.
  state.skills = state.skills.filter(s => s.source_repo !== sourceLabel).concat(scan.skills)
  state.agents = state.agents.filter(a => a.source_repo !== sourceLabel).concat(scan.agents)
  state.mcps = state.mcps.filter(m => m.source_repo !== sourceLabel).concat(scan.mcps)
  return {
    source, source_repo: sourceLabel, ok: true,
    last_refreshed_at: new Date().toISOString(),
    counts: {
      skills: scan.skills.length,
      agents: scan.agents.length,
      mcps: scan.mcps.length,
      errors: scan.errors.length,
    },
  }
}

export async function refreshDiscovery(): Promise<RegistryState> {
  if (refreshing) return state
  refreshing = true
  try {
    const cfg = getDiscoveryConfig()
    const repos: RepoStatus[] = []
    for (const src of cfg.sources) {
      repos.push(await refreshOne(src))
    }
    state = {
      repos,
      skills: state.skills,
      agents: state.agents,
      mcps: state.mcps,
      lastRefreshedAt: new Date().toISOString(),
    }
    return state
  } finally {
    refreshing = false
  }
}

/** Best-effort startup refresh + periodic timer. Never throws. */
export function startDiscoveryWorker(): void {
  if (!isDiscoveryEnabled()) return
  // Kick off immediately, swallow errors so readiness isn't blocked.
  refreshDiscovery().catch(err => {
    console.warn('[discovery] initial refresh failed:', (err as Error).message)
  })
  if (refreshTimer) return
  const cfg = getDiscoveryConfig()
  refreshTimer = setInterval(() => {
    refreshDiscovery().catch(err => {
      console.warn('[discovery] periodic refresh failed:', (err as Error).message)
    })
  }, cfg.refreshIntervalMs)
  refreshTimer.unref?.()
}

export function getDiscoveryState(): RegistryState {
  return state
}

export function getDiscoveredSkills(): DiscoveredSkill[] {
  // Honor the global skills toggle. If the feature is off we report
  // no discovered skills so the API surface, the agent's tool schema,
  // and the Console UI all stay consistent.
  try {
    const { isSkillsEnabled } = require('../features/flags.js') as {
      isSkillsEnabled: () => boolean
    }
    if (!isSkillsEnabled()) return []
  } catch {
    // Feature flag module not initialised yet (early boot) -- fall
    // through to the cached state.
  }
  return state.skills
}
export function getDiscoveredAgents(): DiscoveredAgent[] { return state.agents }
export function getDiscoveredMcps(): DiscoveredMcp[] { return state.mcps }

/**
 * Hydrate the registry with a snapshot of discovered entries from
 * outside (e.g., a worker pod that inherits state from the router via
 * WorkerTask.{skillsPalette,agentPalette,mcpPalette}). Bypasses the
 * git/local fetch path entirely. Replaces existing state.
 */
export function setDiscoveredSnapshot(snapshot: {
  skills?: DiscoveredSkill[]
  agents?: DiscoveredAgent[]
  mcps?: DiscoveredMcp[]
}): void {
  state = {
    repos: state.repos,
    skills: snapshot.skills ?? [],
    agents: snapshot.agents ?? [],
    mcps: snapshot.mcps ?? [],
    lastRefreshedAt: new Date().toISOString(),
  }
}
