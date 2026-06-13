/**
 * Self-evolution operator (compose-native).
 *
 * Runs scripts/self-evolve.sh, which builds the agent's own edited source
 * into a candidate image, validates it in a throwaway sandbox, and — only on
 * success and only when promote=true — ships it to the running prod instance
 * with automatic rollback. Gated by RAK00N_SELF_MODIFY_ENABLED (which also
 * implies the repo + docker socket are mounted into this container).
 */
import { spawn } from 'node:child_process'

export function selfModifyEnabled(): boolean {
  return process.env.RAK00N_SELF_MODIFY_ENABLED === '1'
}

export type SelfEvolveInput = { promote?: boolean; timeout_s?: number }

export async function executeSelfEvolve(input: SelfEvolveInput): Promise<string> {
  if (!selfModifyEnabled()) {
    return 'Self-modify is disabled. Enable RAK00N_SELF_MODIFY_ENABLED=1 and mount the repo (/src) + docker socket into rak00n-api.'
  }
  const src = process.env.RAK00N_SELF_SRC || '/src'
  const script = `${src}/scripts/self-evolve.sh`
  const args = input?.promote ? ['--promote'] : []
  const timeoutMs = Math.min(Math.max(input?.timeout_s ?? 600, 60), 1800) * 1000

  return await new Promise<string>(resolve => {
    let out = ''
    const child = spawn('bash', [script, ...args], { cwd: src, env: process.env })
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* */ }
      resolve(out + '\n[ERROR] self-evolve timed out')
    }, timeoutMs)
    child.stdout.on('data', d => { out += d.toString() })
    child.stderr.on('data', d => { out += d.toString() })
    child.on('close', code => { clearTimeout(timer); resolve(out + `\n[self-evolve exit ${code}]`) })
    child.on('error', err => { clearTimeout(timer); resolve(out + `\n[ERROR] ${err.message}`) })
  })
}
