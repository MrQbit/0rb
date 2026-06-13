/**
 * Runtime feature flags for orb2-art.
 *
 * Today we expose ONE flag -- `skills` -- so the same image can be
 * shipped to clients that don't want the skills/MCP-helper surface
 * (some regulated deployments require the agent to operate without
 * any /skill, MCP-server-discovery, or skill-attachment hint at all).
 *
 * Sources, in increasing precedence:
 *
 *   1. Env var `ORB2_SKILLS_ENABLED` (default: '1' = enabled). Read
 *      once at boot and used as the initial value.
 *   2. Redis KV `orb2:features:skills` ('1' or '0'). Persists an
 *      admin-set runtime override across restarts and replicas.
 *
 * If either source EXPLICITLY sets the flag to false, the feature is
 * off everywhere -- the model never sees `Skill` in its tool schema,
 * the skill matcher returns null, the system prompt drops every
 * `/skill` reference, the Console hides the tab, and discovery skips
 * scanning .md skill files. The agent therefore has no opportunity
 * to call or even mention a missing skill.
 *
 * Flipping requires admin auth. We emit a 'feature.changed' audit
 * event on every transition so the relay sees who toggled what.
 */

import { log } from '../log.js'
import type { Store } from '../store/store.js'

export type FeatureFlagSnapshot = {
  enabled: boolean
  source: 'env' | 'kv' | 'merge'
  changedAt: string
  reason?: string
  actor?: string
}

const KEY_SKILLS = 'orb2:features:skills'
const KEY_SKILLS_META = 'orb2:features:skills:meta'

let _store: Store | null = null
let _envSkills = true
let _kvSkills: { value: boolean; reason?: string; actor?: string; at: string } | null =
  null

function parseEnvBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null || value === '') return defaultValue
  const v = value.trim().toLowerCase()
  if (['0', 'false', 'no', 'off'].includes(v)) return false
  if (['1', 'true', 'yes', 'on'].includes(v)) return true
  return defaultValue
}

export async function initFeatureFlags(store: Store): Promise<void> {
  _store = store
  _envSkills = parseEnvBool(process.env.ORB2_SKILLS_ENABLED, true)
  await refresh()
  // 10s polling so a runtime change applied by another router replica
  // propagates without waiting for the next admin POST.
  setInterval(() => {
    refresh().catch(() => {})
  }, 10_000)
}

export async function refresh(): Promise<void> {
  if (!_store) return
  try {
    const raw = await _store.getKv(KEY_SKILLS)
    if (raw == null) {
      _kvSkills = null
    } else {
      const value = raw === '1' || raw.toLowerCase() === 'true'
      let meta: { reason?: string; actor?: string; at?: string } = {}
      try {
        const m = await _store.getKv(KEY_SKILLS_META)
        if (m) meta = JSON.parse(m)
      } catch {
        // ignore meta errors -- the flag itself is the source of truth
      }
      _kvSkills = {
        value,
        reason: meta.reason,
        actor: meta.actor,
        at: meta.at ?? new Date().toISOString(),
      }
    }
  } catch (err) {
    log.warn('feature_flag_refresh_failed', {
      error: (err as Error).message,
    })
  }
}

export function isSkillsEnabled(): boolean {
  // The KV override, if present, wins. Otherwise fall back to the
  // boot-time env var.
  if (_kvSkills) return _kvSkills.value
  return _envSkills
}

export function getSkillsSnapshot(): FeatureFlagSnapshot {
  if (_kvSkills) {
    return {
      enabled: _kvSkills.value,
      source: 'kv',
      changedAt: _kvSkills.at,
      reason: _kvSkills.reason,
      actor: _kvSkills.actor,
    }
  }
  return {
    enabled: _envSkills,
    source: 'env',
    changedAt: new Date(0).toISOString(),
  }
}

export async function setSkillsEnabled(
  enabled: boolean,
  reason?: string,
  actor?: string,
): Promise<FeatureFlagSnapshot> {
  if (!_store) throw new Error('feature flags not initialised')
  const at = new Date().toISOString()
  await _store.putKv(KEY_SKILLS, enabled ? '1' : '0', 0)
  await _store.putKv(
    KEY_SKILLS_META,
    JSON.stringify({ reason, actor, at }),
    0,
  )
  _kvSkills = { value: enabled, reason, actor, at }
  return getSkillsSnapshot()
}

export function getAllFeatureFlags(): { skills: FeatureFlagSnapshot } {
  return { skills: getSkillsSnapshot() }
}
