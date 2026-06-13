/**
 * Body parsing helper — runs Zod safeParse and produces a 400
 * VALIDATION_FAILED Response on failure, including the issue list
 * (path + message) for client debugging.
 *
 * Return contract is a discriminated union that narrows under
 * `strict: false` via `instanceof Response`. Handlers call:
 *
 *   const parsed = await parseBody(req, MySchema)
 *   if (parsed instanceof Response) return parsed
 *   // parsed.data is now typed
 */
import { z } from 'zod'

export type ParseSuccess<T> = { data: T }
export type ParseResult<T> = ParseSuccess<T> | Response

async function readJson(req: Request): Promise<unknown | null> {
  try {
    return await req.json()
  } catch {
    return null
  }
}

function bad(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export async function parseBody<T>(
  req: Request,
  schema: z.ZodType<T>,
): Promise<ParseResult<T>> {
  const raw = await readJson(req)
  if (raw === null) {
    return bad(400, { error: 'invalid JSON body', code: 'INVALID_JSON' })
  }
  const result = schema.safeParse(raw)
  if (!result.success) {
    return bad(400, {
      error: 'Request body failed validation',
      code: 'VALIDATION_FAILED',
      issues: result.error.issues.map(i => ({
        path: i.path.join('.'),
        message: i.message,
        code: i.code,
      })),
    })
  }
  return { data: result.data }
}
