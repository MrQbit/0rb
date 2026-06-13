import { z } from 'zod'

const EMAIL = z
  .string()
  .trim()
  .min(3)
  .max(256)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'must be a valid email')

const TOOL_OR_MODEL_NAME = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/)

export const CreateKeyRequest = z.object({
  name: z.string().trim().min(1).max(128),
  owner_email: EMAIL.optional(),
  allowed_models: z.array(TOOL_OR_MODEL_NAME).max(64).optional(),
  allowed_tools: z.array(TOOL_OR_MODEL_NAME).max(64).optional(),
  admin: z.boolean().optional(),
})
export type CreateKeyRequestT = z.infer<typeof CreateKeyRequest>
