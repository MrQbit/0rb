import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { executeCode, isSandboxEnabled } from './executor.ts'

const ORIG = { ...process.env }

describe('sandbox executor', () => {
  beforeEach(() => {
    delete process.env.RAK00N_SANDBOX_ENABLED
    delete process.env.RAK00N_SANDBOX_MODE
    delete process.env.RAK00N_SANDBOX_URL
  })
  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in ORIG)) delete process.env[k]
    }
    Object.assign(process.env, ORIG)
  })

  test('isSandboxEnabled is true by default and false when disabled', () => {
    expect(isSandboxEnabled()).toBe(true)
    process.env.RAK00N_SANDBOX_ENABLED = '0'
    expect(isSandboxEnabled()).toBe(false)
    process.env.RAK00N_SANDBOX_ENABLED = 'false'
    expect(isSandboxEnabled()).toBe(false)
  })

  test('rejects unsupported language', async () => {
    const r = await executeCode('ruby', 'puts 1', undefined)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('Unsupported language')
  })

  test('returns disabled message when RAK00N_SANDBOX_ENABLED=0', async () => {
    process.env.RAK00N_SANDBOX_ENABLED = '0'
    const r = await executeCode('python3', 'print(1)', undefined)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('Code execution is disabled')
  })

  test('inproc mode: child cannot see credential env vars', async () => {
    process.env.RAK00N_SANDBOX_MODE = 'inproc'
    process.env.LLM_KEY = 'super-secret-leaked'
    process.env.OPENAI_API_KEY = 'sk-leaked'
    process.env.RAK00N_BOOTSTRAP_ADMIN_KEY = 'rak00n_leaked'
    const code = `import os, sys; sys.stdout.write(','.join(sorted(k for k in os.environ.keys())))`
    const r = await executeCode('python3', code, undefined)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).not.toContain('LLM_KEY')
    expect(r.stdout).not.toContain('OPENAI_API_KEY')
    expect(r.stdout).not.toContain('RAK00N_BOOTSTRAP_ADMIN_KEY')
    expect(r.stdout).toContain('PATH')
    expect(r.stdout).toContain('HOME')
  })

  test('pod mode: dispatches HTTP POST to the sandbox URL', async () => {
    process.env.RAK00N_SANDBOX_MODE = 'pod'
    process.env.RAK00N_SANDBOX_URL = 'http://localhost:1' // unreachable
    const r = await executeCode('python3', 'print(1)', undefined)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('sandbox pod unreachable')
  })
})
