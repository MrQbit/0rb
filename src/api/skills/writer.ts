import { writeFileSync, unlinkSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'

export type SkillInput = {
  name: string
  description: string
  instructions: string
  keywords?: string
  mcpServers?: Array<{
    name: string
    url: string
    transport?: string
    headers?: Record<string, string>
  }>
}

export function serializeSkill(skill: SkillInput): string {
  let yaml = `---\nname: ${skill.name}\ndescription: ${skill.description}\n`

  if (skill.keywords) {
    yaml += `keywords: ${skill.keywords}\n`
  }

  if (skill.mcpServers && skill.mcpServers.length > 0) {
    yaml += `mcp_servers:\n`
    for (const s of skill.mcpServers) {
      yaml += `  ${s.name}:\n`
      yaml += `    url: ${s.url}\n`
      yaml += `    transport: ${s.transport || 'streamable_http'}\n`
      if (s.headers && Object.keys(s.headers).length > 0) {
        yaml += `    headers:\n`
        for (const [k, v] of Object.entries(s.headers)) {
          yaml += `      ${k}: "${v}"\n`
        }
      }
    }
  }

  yaml += `---\n\n${skill.instructions}`
  return yaml
}

export function writeSkillFile(skillsDir: string, name: string, content: string): void {
  const filePath = join(skillsDir, `${name}.md`)
  writeFileSync(filePath, content, 'utf-8')
}

export function deleteSkillFile(skillsDir: string, name: string): void {
  const filePath = join(skillsDir, `${name}.md`)
  if (existsSync(filePath)) {
    unlinkSync(filePath)
  }
}

export function readSkillRaw(skillsDir: string, name: string): string | null {
  const filePath = join(skillsDir, `${name}.md`)
  if (!existsSync(filePath)) return null
  return readFileSync(filePath, 'utf-8')
}

const DISABLED_KV_PREFIX = 'skill:disabled:'

export function disabledSkillKey(name: string): string {
  return `${DISABLED_KV_PREFIX}${name}`
}
