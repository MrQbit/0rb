import { executeCode, isSandboxEnabled } from './executor.js'

export type RunCodeInput = {
  language: string
  code: string
  stdin?: string
}

export type RunCodeResult = {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
  timedOut: boolean
}

export async function executeRunCode(input: RunCodeInput): Promise<RunCodeResult> {
  return executeCode(input.language, input.code, input.stdin)
}

export const RUN_CODE_TOOL_DEF = {
  name: 'RunCode',
  description: 'Execute a stateless code snippet. Python3 only. No network access, no persistent storage, /tmp only writable directory. 30 second timeout, 512KB max output. Use for calculations, data transformation, config validation, or any computation that benefits from actual code execution.',
  input_schema: {
    type: 'object' as const,
    properties: {
      language: {
        type: 'string' as const,
        enum: ['python3'],
        description: 'Programming language to use. Currently only python3 is supported.',
      },
      code: {
        type: 'string' as const,
        description: 'The code to execute. Must be self-contained.',
      },
      stdin: {
        type: 'string' as const,
        description: 'Optional stdin input to pass to the program.',
      },
    },
    required: ['language', 'code'],
  },
}

export { isSandboxEnabled }
