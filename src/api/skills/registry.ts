import { dirname, join } from 'path'
import { existsSync } from 'fs'
import { loadSkills, type SkillDefinition, type SkillMcpServer } from './loader.js'
import { disabledSkillKey } from './writer.js'
import { isSkillsEnabled } from '../features/flags.js'

let cachedSkills: SkillDefinition[] | null = null
const disabledSkills = new Set<string>()

export function getSkillsDir(): string {
  const candidates = [
    join(dirname(process.argv[1] || '.'), 'skills'),  // next to the bundle
    join(process.cwd(), 'src', 'api', 'skills'),       // dev mode
  ]
  for (const dir of candidates) {
    if (existsSync(dir)) return dir
  }
  return candidates[0]!
}

export function getAllSkills(): SkillDefinition[] {
  if (!cachedSkills) {
    cachedSkills = loadSkills(getSkillsDir())
  }
  return cachedSkills
}

export function getEnabledSkills(): SkillDefinition[] {
  // Global feature gate. When skills are turned off for this
  // deployment we hand back an empty list so every downstream
  // consumer (matcher, system prompt, attachments, dynamic command
  // registration) silently treats this build as having no skills.
  if (!isSkillsEnabled()) return []
  const local = getAllSkills().filter(s => !disabledSkills.has(s.name))
  let discovered: SkillDefinition[] = []
  try {
    const reg = require('../discovery/registry.js') as {
      getDiscoveredSkills: () => Array<{
        name: string
        description: string
        instructions: string
      }>
    }
    discovered = reg.getDiscoveredSkills()
      .filter(s => !disabledSkills.has(s.name))
      .map(s => ({
        name: s.name,
        description: s.description,
        instructions: s.instructions,
        mcpServers: [],
      }))
  } catch { /* discovery optional / not yet booted */ }
  return [...local, ...discovered]
}

export function invalidateSkillCache(): void {
  cachedSkills = null
}

export function isSkillDisabled(name: string): boolean {
  return disabledSkills.has(name)
}

export function setSkillDisabled(name: string, disabled: boolean): void {
  if (disabled) {
    disabledSkills.add(name)
  } else {
    disabledSkills.delete(name)
  }
}

export async function loadDisabledSkills(store: { getKv(key: string): Promise<string | null> }): Promise<void> {
  const skills = getAllSkills()
  for (const skill of skills) {
    const val = await store.getKv(disabledSkillKey(skill.name))
    if (val === '1') disabledSkills.add(skill.name)
  }
}

// Skill matching is driven exclusively by each skill's frontmatter:
//
//   keywords:  comma-separated list of phrases (single line OR YAML "|" block)
//   description: short prose; used as a low-confidence fallback when no
//                keyword matched anything
//
// Adding a new skill is just dropping the .md file in this directory; the
// loader picks it up and the matcher uses its frontmatter automatically.
//
// Each phrase contributes a uniform score of +10 when present (case-insensitive
// substring match). Longer phrases are checked first so specific phrases tend
// to outweigh generic ones (e.g. "create an app" wins over "app"). When a
// matching skill is desired with extra confidence, simply list the same phrase
// multiple times in the keywords field — each occurrence adds +10.
export function matchSkill(message: string): SkillDefinition | null {
  if (!isSkillsEnabled()) return null
  const skills = getEnabledSkills()
  if (skills.length === 0) return null

  const lower = message.toLowerCase()
  const scores: { skill: SkillDefinition; score: number }[] = []

  for (const skill of skills) {
    if (!skill.keywords) continue
    const kwList = skill.keywords
      .split(',')
      .map(k => k.trim().toLowerCase())
      .filter(Boolean)
    if (kwList.length === 0) continue

    // Longest phrases first — specific over generic.
    const sorted = [...kwList].sort((a, b) => b.length - a.length)
    let score = 0
    for (const kw of sorted) {
      if (lower.includes(kw)) score += 10
    }
    if (score > 0) scores.push({ skill, score })
  }

  if (scores.length > 0) {
    scores.sort((a, b) => b.score - a.score)
    return scores[0]!.skill
  }

  // Low-confidence fallback: skill description words (≥2 matches required).
  for (const skill of skills) {
    const descWords = skill.description.toLowerCase().split(/\s+/)
    const hits = descWords.filter(w => w.length > 4 && lower.includes(w))
    if (hits.length >= 2) return skill
  }

  return null
}

export type { SkillDefinition, SkillMcpServer }
