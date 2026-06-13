import { isSandboxEnabled, executeRunCode } from './tool.js'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = await req.json()
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export async function tryHandleSandboxRoute(
  req: Request,
  pathname: string,
): Promise<Response | null> {
  if (req.method !== 'POST' || pathname !== '/v1/sandbox/run') return null
  if (!isSandboxEnabled()) {
    return jsonResponse(503, {
      error: 'sandbox is not enabled in this build',
      code: 'SANDBOX_DISABLED',
    })
  }
  const body = (await readJson(req)) ?? {}
  const language = String(body.language ?? 'python3')
  const code = String(body.code ?? '')
  if (!code) return jsonResponse(400, { error: 'code is required' })
  try {
    const out = await executeRunCode({
      language,
      code,
      stdin: typeof body.stdin === 'string' ? body.stdin : undefined,
    })
    return jsonResponse(200, out)
  } catch (err) {
    return jsonResponse(500, {
      error: 'sandbox run failed',
      message: (err as Error).message,
    })
  }
}
