/**
 * Auto-memory location + enable gate for the orb.
 *
 * Recovered, simplified, into the API tree during the re-platform off the
 * legacy core (was memdir/paths.ts, which carried project-scoped settings.json
 * resolution the orb never uses). The orb sets the full path via
 * ORB2_COWORK_MEMORY_PATH_OVERRIDE (compose: /memory on a durable volume).
 */
import { join } from 'node:path'

function truthy(v: string | undefined): boolean {
  const s = (v ?? '').trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

/** Whether the agent's file-based auto-memory (MEMORY.md + topic files) is on. */
export function isAutoMemoryEnabled(): boolean {
  return !truthy(process.env.ORB2_DISABLE_AUTO_MEMORY)
}

/**
 * Absolute path to the memory directory (with a trailing separator), where
 * MEMORY.md and topic files live. Driven by ORB2_COWORK_MEMORY_PATH_OVERRIDE
 * (or ORB2_MEMORY_DIR); defaults to ~/.orb2/memory.
 */
export function getAutoMemPath(): string {
  const override = (
    process.env.ORB2_COWORK_MEMORY_PATH_OVERRIDE ||
    process.env.ORB2_MEMORY_DIR ||
    ''
  ).trim()
  if (override) return override.endsWith('/') ? override : override + '/'
  const home = process.env.HOME || process.env.USERPROFILE || '.'
  return join(home, '.orb2', 'memory') + '/'
}
