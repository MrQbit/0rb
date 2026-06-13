import { z } from 'zod'

export const ToolInvokeRequest = z.object({
  arguments: z.record(z.string(), z.unknown()),
  session_id: z.string().trim().max(128).optional(),
  working_directory: z.string().trim().max(512).optional(),
  model: z.string().trim().max(128).optional(),
})
export type ToolInvokeRequestT = z.infer<typeof ToolInvokeRequest>
