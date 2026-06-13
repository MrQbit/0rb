/**
 * Discovery config: which repositories to scan for skills, MCPs, and
 * sub-agent definitions.
 *
 * Repos are configured via:
 *   - RAK00N_DISCOVERY_PATHS env (comma-separated absolute paths or
 *     git URLs). Each entry is either a local filesystem path or a
 *     git URL pointing into the private EMU GitHub org.
 *
 * Git URLs are restricted by an allowlist regex -- only repositories
 * inside the configured EMU GitHub Enterprise org may be cloned. The
 * default allowlist accepts `https://github.com/rak00n-core/*` and
 * `git@github.com:rak00n-core/*`. Override the org name via
 * RAK00N_DISCOVERY_GIT_ALLOWED_ORG.
 *
 * Public GitHub repos are NEVER cloned through this surface, by
 * design -- discovery feeds the agent palette and the trust boundary
 * has to match the org's existing IAM perimeter.
 */
import { existsSync, statSync } from 'node:fs'
import { resolve, isAbsolute } from 'node:path'

export type DiscoverySource =
  | { kind: 'path'; path: string }
  | { kind: 'git'; url: string }

export type DiscoveryConfig = {
  sources: DiscoverySource[]
  /** Where to clone git URLs. Persistent across pod restarts when mounted. */
  cacheRoot: string
  /** EMU org name. Default 'rak00n-core'. */
  emuOrg: string
  /** Periodic refresh interval in ms. */
  refreshIntervalMs: number
}

const DEFAULT_CACHE_ROOT = '/var/rak00n/discovery'
const DEFAULT_REFRESH_INTERVAL_MS = 15 * 60 * 1000

export function getEmuOrg(): string {
  return (process.env.RAK00N_DISCOVERY_GIT_ALLOWED_ORG || 'rak00n-core').trim()
}

/**
 * Returns true if a git URL points at a repo inside the configured
 * EMU org. Accepts both HTTPS and SSH forms.
 */
export function isAllowedGitUrl(url: string): boolean {
  const org = getEmuOrg().toLowerCase()
  if (!org) return false
  const u = url.trim().toLowerCase()
  // https://github.com/<org>/<repo>(.git)?
  // https://github.com/<org>/<repo>(.git)?(/...)?
  // git@github.com:<org>/<repo>(.git)?
  if (u.startsWith(`https://github.com/${org}/`)) return true
  if (u.startsWith(`git@github.com:${org}/`)) return true
  if (u.startsWith(`ssh://git@github.com/${org}/`)) return true
  return false
}

function parseSource(raw: string): DiscoverySource | null {
  const v = raw.trim()
  if (!v) return null
  // Absolute filesystem path
  if (isAbsolute(v)) {
    if (!existsSync(v)) return null
    if (!statSync(v).isDirectory()) return null
    return { kind: 'path', path: resolve(v) }
  }
  // Git URL forms (HTTPS / SSH / ssh://)
  if (
    v.startsWith('https://') ||
    v.startsWith('git@') ||
    v.startsWith('ssh://')
  ) {
    if (!isAllowedGitUrl(v)) {
      console.warn(`[discovery] rejected non-EMU git url: ${v}`)
      return null
    }
    return { kind: 'git', url: v }
  }
  console.warn(`[discovery] ignoring non-absolute, non-git source: ${v}`)
  return null
}

export function getDiscoveryConfig(): DiscoveryConfig {
  const raw = process.env.RAK00N_DISCOVERY_PATHS || ''
  const sources = raw
    .split(',')
    .map(parseSource)
    .filter((s): s is DiscoverySource => s !== null)
  const cacheRoot = process.env.RAK00N_DISCOVERY_CACHE_DIR || DEFAULT_CACHE_ROOT
  const refreshSec = parseInt(
    process.env.RAK00N_DISCOVERY_REFRESH_SECONDS || '900',
    10,
  )
  return {
    sources,
    cacheRoot,
    emuOrg: getEmuOrg(),
    refreshIntervalMs: Number.isFinite(refreshSec) && refreshSec > 0
      ? refreshSec * 1000
      : DEFAULT_REFRESH_INTERVAL_MS,
  }
}

export function isDiscoveryEnabled(): boolean {
  return getDiscoveryConfig().sources.length > 0
}
