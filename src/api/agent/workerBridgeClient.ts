/**
 * Worker-side client for the bridge endpoints.
 *
 * Tools running inside a K8s worker pod that need to invoke
 * router-managed services (jobs, sub-worker spawn, sandbox, vault,
 * memory) call into this module. It reads `RAK00N_INTERNAL_TOKEN` and
 * `RAK00N_INTERNAL_API_URL` from env (injected by `launchWorkerJob`)
 * and POSTs to `/v1/internal/turn/<turnId>/...`.
 *
 * Fail-safe by design: if the bridge is unreachable or the env isn't
 * set (e.g. running outside K8s in dev) every method resolves with
 * `{ ok: false, error }` instead of throwing, so tools degrade
 * gracefully and never crash the agent loop.
 */

const DEFAULT_TIMEOUT_MS = 10_000

export type BridgeResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number }

function getEnv() {
  const url = process.env.RAK00N_INTERNAL_API_URL
  const token = process.env.RAK00N_INTERNAL_TOKEN
  const turnId = process.env.RAK00N_INTERNAL_TURN_ID
  if (!url || !token || !turnId) return null
  return { url: url.replace(/\/+$/, ''), token, turnId }
}

export function isBridgeAvailable(): boolean {
  return getEnv() !== null
}

async function bridgeFetch<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  suffix: string,
  body?: unknown,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<BridgeResult<T>> {
  const env = getEnv()
  if (!env) {
    return { ok: false, error: 'bridge not configured (worker env missing)' }
  }
  const url = `${env.url}/v1/internal/turn/${env.turnId}/${suffix}`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-rak00n-bridge-token': env.token,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    })
    const text = await res.text()
    let parsed: unknown = null
    try { parsed = text ? JSON.parse(text) : null } catch { /* keep as text */ }
    if (!res.ok) {
      const errMsg =
        (parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as any).error === 'string')
          ? (parsed as any).error
          : `bridge returned HTTP ${res.status}`
      return { ok: false, error: errMsg, status: res.status }
    }
    return { ok: true, data: parsed as T }
  } catch (err) {
    return { ok: false, error: (err as Error).message || 'bridge fetch failed' }
  } finally {
    clearTimeout(timer)
  }
}

// ─── Convenience methods ───

export type SubmitJobInput = {
  type: string
  description: string
  params?: Record<string, unknown>
  requires_approval?: boolean
}
export type SubmitJobOutput = {
  jobId: string
  status: string
  message: string
  requiresApproval: boolean
}

export const bridge = {
  submitJob(input: SubmitJobInput) {
    return bridgeFetch<SubmitJobOutput>('POST', 'jobs', input)
  },

  spawnSubWorker(input: {
    message: string
    model?: string
    previous_messages?: unknown[]
    working_directory?: string
    knobs?: Record<string, unknown>
    turn_id?: string
  }) {
    return bridgeFetch<{ child_turn_id: string; job_name: string; reused: boolean }>(
      'POST', 'workers/spawn', input,
    )
  },

  runSandbox(input: { language: string; code: string; stdin?: string }) {
    return bridgeFetch<{
      stdout: string
      stderr: string
      exitCode: number
      durationMs: number
      timedOut: boolean
    }>('POST', 'sandbox/run', input)
  },

  vaultRead(notePath: string) {
    return bridgeFetch<{ found: boolean; note?: any }>(
      'GET', `vault/note/${encodeURIComponent(notePath)}`,
    )
  },
  vaultWrite(notePath: string, content: string, tags?: string[]) {
    return bridgeFetch<{ path: string; title: string; isNew: boolean }>(
      'PUT', `vault/note/${encodeURIComponent(notePath)}`, { content, tags },
    )
  },
  vaultSearch(query: string, tags?: string[]) {
    return bridgeFetch<{ results: any[] }>('POST', 'vault/search', { query, tags })
  },

  recordMemoryDigest(digest: Record<string, unknown>) {
    return bridgeFetch<{ ok: boolean }>('POST', 'memory/digest', digest)
  },
}
