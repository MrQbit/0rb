/**
 * Clones EMU-hosted repositories into the discovery cache via the
 * git binary in the runtime image. Only the four config dirs we
 * actually consume are checked out (sparse checkout) so we never
 * pull large source trees:
 *
 *   .rak00n/skills/      .rak00n/agents/
 *   .mcp.json          mcp_servers.json
 *
 * Git URL is verified via isAllowedGitUrl() before any subprocess
 * runs -- the allowlist is the trust boundary.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { isAllowedGitUrl } from './config.js'

const SPARSE_PATTERNS = [
  '.rak00n/skills/*',
  '.rak00n/agents/*',
  '.mcp.json',
  'mcp_servers.json',
]

function execGit(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolveP, reject) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}), GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 30_000)
    child.on('error', err => { clearTimeout(timer); reject(err) })
    child.on('close', code => {
      clearTimeout(timer)
      resolveP({ stdout, stderr, code: code ?? -1 })
    })
  })
}

export function repoHash(url: string): string {
  return createHash('sha1').update(url).digest('hex').slice(0, 12)
}

export function cachePathFor(url: string, cacheRoot: string): string {
  return join(cacheRoot, repoHash(url))
}

/**
 * Clone (first run) or fetch + reset (subsequent runs) the repo at
 * `url` into the discovery cache. Sparse checkout limits the on-disk
 * footprint to the four config files we actually consume.
 */
export async function ensureRepo(
  url: string,
  cacheRoot: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (!isAllowedGitUrl(url)) {
    return { ok: false, error: `URL not in EMU allowlist: ${url}` }
  }
  mkdirSync(cacheRoot, { recursive: true })
  const dst = cachePathFor(url, cacheRoot)

  try {
    if (!existsSync(dst)) {
      // Initial clone: --filter=blob:none keeps history light, sparse
      // checkout limits paths.
      const r = await execGit([
        'clone',
        '--filter=blob:none',
        '--no-checkout',
        '--depth=1',
        url,
        dst,
      ], { timeoutMs: 60_000 })
      if (r.code !== 0) {
        return { ok: false, error: `git clone failed: ${r.stderr.slice(0, 200)}` }
      }
      const sp = await execGit(['sparse-checkout', 'init', '--cone'], { cwd: dst })
      if (sp.code !== 0) {
        return { ok: false, error: `git sparse-checkout init failed: ${sp.stderr.slice(0, 200)}` }
      }
      const set = await execGit([
        'sparse-checkout', 'set', '--no-cone', ...SPARSE_PATTERNS,
      ], { cwd: dst })
      if (set.code !== 0) {
        return { ok: false, error: `git sparse-checkout set failed: ${set.stderr.slice(0, 200)}` }
      }
      const co = await execGit(['checkout', 'HEAD'], { cwd: dst })
      if (co.code !== 0) {
        return { ok: false, error: `git checkout failed: ${co.stderr.slice(0, 200)}` }
      }
    } else {
      // Refresh: fetch + reset to remote HEAD.
      const fetched = await execGit(['fetch', '--depth=1', 'origin'], {
        cwd: dst, timeoutMs: 60_000,
      })
      if (fetched.code !== 0) {
        return { ok: false, error: `git fetch failed: ${fetched.stderr.slice(0, 200)}` }
      }
      const reset = await execGit(['reset', '--hard', 'origin/HEAD'], { cwd: dst })
      if (reset.code !== 0) {
        return { ok: false, error: `git reset failed: ${reset.stderr.slice(0, 200)}` }
      }
    }
    return { ok: true, path: dst }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
