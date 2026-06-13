/**
 * Auto-memory location + enable gate for the orb.
 *
 * Recovered, simplified, into the API tree during the re-platform off the
 * legacy core (was memdir/paths.ts, which carried project-scoped settings.json
 * resolution the orb never uses). The orb sets the full path via
 * RAK00N_COWORK_MEMORY_PATH_OVERRIDE (compose: /memory on a durable volume).
 */
import { join } from 'node:path'

function truthy(v: string | undefined): boolean {
  const s = (v ?? '').trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

/** Whether the agent's file-based auto-memory (MEMORY.md + topic files) is on. */
export function isAutoMemoryEnabled(): boolean {
  return !truthy(process.env.RAK00N_DISABLE_AUTO_MEMORY)
}

/**
 * Absolute path to the memory directory (with a trailing separator), where
 * MEMORY.md and topic files live. Driven by RAK00N_COWORK_MEMORY_PATH_OVERRIDE
 * (or RAK00N_MEMORY_DIR); defaults to ~/.rak00n/memory.
 */
export function getAutoMemPath(): string {
  const override = (
    process.env.RAK00N_COWORK_MEMORY_PATH_OVERRIDE ||
    process.env.RAK00N_MEMORY_DIR ||
    ''
  ).trim()
  if (override) return override.endsWith('/') ? override : override + '/'
  const home = process.env.HOME || process.env.USERPROFILE || '.'
  return join(home, '.rak00n', 'memory') + '/'
}
