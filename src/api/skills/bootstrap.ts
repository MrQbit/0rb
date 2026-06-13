/**
 * Embedded-skill bootstrap.
 *
 * Walks the bundled `dist/skills/` (mounted at `/opt/rak00n-api/skills/`
 * inside the container) and registers each `.md` file with the SDK's
 * `registerBundledSkill()` registry. After this runs, every skill
 * shipped in the image is permanently visible to the agent's
 * SkillTool regardless of cwd — exactly like the SDK's built-in
 * `simplify`, `keybindings`, etc.
 *
 * Why this matters: `matchSkill()` already used the embedded set, but
 * the SDK's SkillTool is a SEPARATE codepath that scans
 * `<cwd>/.rak00n/skills/*.md` + the in-process bundled registry. For
 * third-party UIs whose cwd has no `.rak00n/skills` directory the
 * SkillTool found zero entries and the agent answered "no skills are
 * available".
 *
 * Discovered skills (repository-imported) never reach this bundled
 * registry — they live in the matcher-only path — so they cannot
 * shadow embedded skills here.
 */
import { getAllSkills, isSkillDisabled } from './registry.js'
import type { SkillDefinition } from './loader.js'

let bootstrapped = false

export async function bootstrapEmbeddedSkills(): Promise<{
  registered: string[]
  skipped: string[]
}> {
  if (bootstrapped) {
    return { registered: [], skipped: getAllSkills().map(s => s.name) }
  }
  bootstrapped = true

  // RECOVERY TODO (re-platform): this used to register embedded skills into
  // the legacy core's SDK slash-command registry via rak00n-core's
  // registerBundledSkill. The core has no such registry yet; skills
  // are loaded from markdown by the loader (getAllSkills) and matched by
  // ./skills/registry. Until skill matching is re-wired onto the agent core
  // (see agentRunner RECOVERY TODOs), this is a no-op so nothing imports the
  // deleted core. Skills remain listable/enabled via the loader.
  const registered: string[] = []
  const skipped: string[] = getAllSkills().map(s => s.name)
  void deriveListingLine // retained for the recovery path; referenced to satisfy lint
  return { registered, skipped }
}

function deriveListingLine(skill: SkillDefinition): string {
  const firstSentence = skill.description.split(/(?<=[.!?])\s/)[0] ?? skill.description
  return firstSentence.length > 200 ? firstSentence.slice(0, 197) + '...' : firstSentence
}
