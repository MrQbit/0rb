import { z } from 'zod'

export const SandboxRunRequest = z.object({
  language: z.enum(['python3']).default('python3'),
  code: z.string().min(1).max(256 * 1024),
  stdin: z.string().max(64 * 1024).optional(),
  timeoutMs: z.number().int().min(100).max(60_000).optional(),
})
export type SandboxRunRequestT = z.infer<typeof SandboxRunRequest>
