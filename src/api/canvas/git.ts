/**
 * Auto-init / auto-commit for the Canvas workspace.
 *
 * Every Canvas tool invocation that writes files runs through here so
 * the workspace stays a clean git repo the user can later sync to an
 * EMU org (see /v1/canvas/{sid}/git/remote and the fabric-app skill).
 *
 * Design:
 *   - The cwd is always the session's working directory; <cwd>/.canvas
 *     holds the SPA files. We init the repo at cwd (NOT at .canvas/)
 *     so other workspace-level artifacts stay tracked too.
 *   - Commit identity preference:
 *       1. Signed-in GitHub user's name/email (RAK00N_GIT_AUTHOR_NAME / EMAIL)
 *       2. Service fallback "Rak00n Canvas <rak00n@noreply.local>"
 *   - All commits are made with the `--allow-empty-message` flag
 *     disabled so empty diffs simply produce a no-op rather than an
 *     error.
 *   - Toggle the whole feature off with RAK00N_CANVAS_GIT_AUTOCOMMIT=0.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export type GitResult = { ok: boolean; stdout: string; stderr: string; code: number }

function isEnabled(): boolean {
  const v = process.env.RAK00N_CANVAS_GIT_AUTOCOMMIT
  return v !== '0' && v !== 'false'
}

export async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise(resolve => {
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
    }
    const child = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('close', code => {
      resolve({ ok: code === 0, stdout, stderr, code: code ?? -1 })
    })
    child.on('error', err => {
      resolve({ ok: false, stdout, stderr: stderr + (err as Error).message, code: -1 })
    })
  })
}

function authorName(): string {
  return (
    process.env.RAK00N_GIT_AUTHOR_NAME?.trim() ||
    process.env.GIT_AUTHOR_NAME?.trim() ||
    'Rak00n Canvas'
  )
}

function authorEmail(): string {
  return (
    process.env.RAK00N_GIT_AUTHOR_EMAIL?.trim() ||
    process.env.GIT_AUTHOR_EMAIL?.trim() ||
    'rak00n-canvas@noreply.local'
  )
}

const STARTER_GITIGNORE = [
  'node_modules/',
  'dist/',
  '.DS_Store',
  '*.log',
  '.env',
  '.env.*',
  '',
].join('\n')

/** Idempotently initialize a git repo at `cwd` and create the first commit. */
export async function ensureCanvasGitRepo(cwd: string): Promise<void> {
  if (!isEnabled()) return
  if (!cwd) return
  if (existsSync(join(cwd, '.git'))) return

  const init = await runGit(cwd, ['init', '-q', '-b', 'main'])
  if (!init.ok) return

  await runGit(cwd, ['config', 'user.name', authorName()])
  await runGit(cwd, ['config', 'user.email', authorEmail()])

  // Drop a starter .gitignore if the user doesn't already have one.
  const { writeFileSync } = await import('node:fs')
  const ig = join(cwd, '.gitignore')
  if (!existsSync(ig)) {
    try { writeFileSync(ig, STARTER_GITIGNORE) } catch { /* tolerate */ }
  }

  await runGit(cwd, ['add', '-A'])
  // Make the initial commit even if there's nothing tracked yet; an
  // empty commit gives us a HEAD to push later.
  await runGit(cwd, ['commit', '--allow-empty', '-m', 'Initial canvas commit'])
}

/** Stage all canvas-related files and commit if the diff is non-empty. */
export async function autoCommit(cwd: string, message: string): Promise<void> {
  if (!isEnabled()) return
  if (!cwd) return
  // Lazily init in case the agent skipped the init action and went
  // straight to write_files.
  await ensureCanvasGitRepo(cwd)
  await runGit(cwd, ['add', '-A'])
  // `git diff --cached --quiet` returns 0 when nothing is staged
  // (i.e. no change), 1 when there are changes. We only commit on 1.
  const cached = await runGit(cwd, ['diff', '--cached', '--quiet'])
  if (cached.code === 0) return
  await runGit(cwd, ['commit', '-m', message])
}

/** Read current branch + last commit + remote for status endpoints. */
export async function canvasGitStatus(cwd: string): Promise<{
  initialized: boolean
  branch?: string
  head?: string
  remote_url?: string
}> {
  if (!cwd || !existsSync(join(cwd, '.git'))) {
    return { initialized: false }
  }
  const branch = (await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  const head = (await runGit(cwd, ['rev-parse', '--short', 'HEAD'])).stdout.trim()
  const remoteRes = await runGit(cwd, ['remote', 'get-url', 'origin'])
  const remote_url = remoteRes.ok ? remoteRes.stdout.trim() : undefined
  return { initialized: true, branch, head, remote_url }
}

/** Attach an origin remote and optionally push the current branch upstream. */
export async function attachRemoteAndPush(
  cwd: string,
  url: string,
  opts: { branch?: string; push?: boolean } = {},
): Promise<GitResult> {
  if (!cwd) return { ok: false, stdout: '', stderr: 'cwd missing', code: -1 }
  await ensureCanvasGitRepo(cwd)
  // Add or update origin.
  const probe = await runGit(cwd, ['remote', 'get-url', 'origin'])
  if (probe.ok) {
    const setUrl = await runGit(cwd, ['remote', 'set-url', 'origin', url])
    if (!setUrl.ok) return setUrl
  } else {
    const add = await runGit(cwd, ['remote', 'add', 'origin', url])
    if (!add.ok) return add
  }
  if (opts.push === false) {
    return { ok: true, stdout: 'remote attached, push skipped', stderr: '', code: 0 }
  }
  const branch = opts.branch?.trim() || 'main'
  // Ensure we have at least one commit before pushing.
  const head = await runGit(cwd, ['rev-parse', 'HEAD'])
  if (!head.ok) {
    await runGit(cwd, ['add', '-A'])
    await runGit(cwd, ['commit', '--allow-empty', '-m', 'Initial canvas commit'])
  }
  // Use --force-with-lease so we won't clobber commits already pushed
  // by another process; first-time pushes are no-ops for this flag.
  return runGit(cwd, ['push', '-u', '--force-with-lease', 'origin', `HEAD:${branch}`])
}
