import { spawn } from 'node:child_process'

export type CodeExecResult = {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
  timedOut: boolean
}

const MAX_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 512 * 1024 // 512KB

function buildMinimalEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: '/tmp',
    TMPDIR: '/tmp',
    PYTHONDONTWRITEBYTECODE: '1',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  }
}

export function isSandboxEnabled(): boolean {
  return process.env.RAK00N_SANDBOX_ENABLED !== '0' && process.env.RAK00N_SANDBOX_ENABLED !== 'false'
}

function sandboxMode(): 'pod' | 'inproc' {
  const m = (process.env.RAK00N_SANDBOX_MODE ?? '').trim().toLowerCase()
  if (m === 'pod') return 'pod'
  if (m === 'inproc' || m === 'in-process' || m === 'in_process') return 'inproc'
  // Default: pod if RAK00N_SANDBOX_URL is set (cluster), inproc otherwise (dev).
  return process.env.RAK00N_SANDBOX_URL ? 'pod' : 'inproc'
}

async function executeViaPod(
  language: string,
  code: string,
  stdin: string | undefined,
): Promise<CodeExecResult> {
  const base = process.env.RAK00N_SANDBOX_URL || 'http://rak00n-sandbox:9091'
  const start = Date.now()
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language, code, stdin, timeoutMs: MAX_TIMEOUT_MS }),
      signal: AbortSignal.timeout(MAX_TIMEOUT_MS + 5_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return {
        stdout: '',
        stderr: `sandbox pod returned ${res.status}: ${text.slice(0, 256)}`,
        exitCode: 1,
        durationMs: Date.now() - start,
        timedOut: false,
      }
    }
    return (await res.json()) as CodeExecResult
  } catch (err) {
    return {
      stdout: '',
      stderr: `sandbox pod unreachable: ${(err as Error).message}`,
      exitCode: 1,
      durationMs: Date.now() - start,
      timedOut: false,
    }
  }
}

export async function executeCode(
  language: string,
  code: string,
  stdin?: string,
): Promise<CodeExecResult> {
  if (!isSandboxEnabled()) {
    return {
      stdout: '',
      stderr: 'Code execution is disabled (RAK00N_SANDBOX_ENABLED=0)',
      exitCode: 1,
      durationMs: 0,
      timedOut: false,
    }
  }

  if (language !== 'python3') {
    return {
      stdout: '',
      stderr: `Unsupported language: ${language}. Only python3 is supported.`,
      exitCode: 1,
      durationMs: 0,
      timedOut: false,
    }
  }

  if (sandboxMode() === 'pod') {
    return executeViaPod(language, code, stdin)
  }

  // In-process fallback (dev only). Strip credentials before spawn so
  // a sandbox escape cannot read upstream secrets from the router env.
  const start = Date.now()
  return new Promise<CodeExecResult>((resolve) => {
    const proc = spawn('python3', ['-c', code], {
      cwd: '/tmp',
      timeout: MAX_TIMEOUT_MS,
      env: buildMinimalEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    proc.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) {
        stdout += chunk.toString()
      }
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) {
        stderr += chunk.toString()
      }
    })

    proc.on('close', (exitCode, signal) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        timedOut = true
      }
      resolve({
        stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
        stderr: stderr.slice(0, MAX_OUTPUT_BYTES),
        exitCode: exitCode ?? 1,
        durationMs: Date.now() - start,
        timedOut,
      })
    })

    proc.on('error', (err) => {
      resolve({
        stdout: '',
        stderr: `Failed to spawn process: ${err.message}`,
        exitCode: 1,
        durationMs: Date.now() - start,
        timedOut: false,
      })
    })

    if (stdin) {
      proc.stdin.write(stdin)
    }
    proc.stdin.end()
  })
}
