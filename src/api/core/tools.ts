/**
 * Built-in file tools for the Orb core.
 *
 * A deliberately small set — Read / Write / Edit / List — used mainly so the
 * agent can keep its own long-term memory files (MEMORY.md + topic notes) and
 * read/update small configs. No shell, no code-search, no bulk editing: Orb is
 * a household assistant, not a coding agent, and a box that controls locks and
 * appliances has no business holding a general shell.
 *
 * Each tool is `{ name, description, inputSchema, call(input) }` returning a
 * string, matching the registry the agent loop drives.
 */
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

export interface CoreTool {
  name: string
  description: string
  inputSchema: any
  call: (input: any) => Promise<string>
}

export const ReadTool: CoreTool = {
  name: 'Read',
  description: 'Read a text file from disk. Returns the content with line numbers.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file' },
      offset: { type: 'number', description: 'First line to read (1-based)' },
      limit: { type: 'number', description: 'Max lines to read' },
    },
    required: ['file_path'],
  },
  async call(input) {
    const path = String(input?.file_path ?? '')
    if (!path) return 'Error: file_path required'
    let text: string
    try { text = await fs.readFile(path, 'utf-8') } catch (e) { return `Error: ${(e as Error).message}` }
    if (text === '') return '[empty file]'
    const lines = text.split('\n')
    const start = Math.max(0, (Number(input?.offset) || 1) - 1)
    const end = input?.limit ? Math.min(lines.length, start + Number(input.limit)) : lines.length
    return lines.slice(start, end).map((l, i) => `${start + i + 1}\t${l}`).join('\n')
  },
}

export const WriteTool: CoreTool = {
  name: 'Write',
  description: 'Write (create or overwrite) a text file. Creates parent folders as needed.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file' },
      content: { type: 'string', description: 'Full file content' },
    },
    required: ['file_path', 'content'],
  },
  async call(input) {
    const path = String(input?.file_path ?? '')
    if (!path) return 'Error: file_path required'
    try {
      await fs.mkdir(dirname(path), { recursive: true })
      await fs.writeFile(path, String(input?.content ?? ''), 'utf-8')
      return `Wrote ${path}`
    } catch (e) { return `Error: ${(e as Error).message}` }
  },
}

export const EditTool: CoreTool = {
  name: 'Edit',
  description: 'Replace an exact text span in a file. old_string must match once unless replace_all is set.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file' },
      old_string: { type: 'string', description: 'Exact text to replace' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence', default: false },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  async call(input) {
    const path = String(input?.file_path ?? '')
    const oldStr = String(input?.old_string ?? '')
    const newStr = String(input?.new_string ?? '')
    if (!path) return 'Error: file_path required'
    if (oldStr === newStr) return 'Error: old_string and new_string are identical'
    let text: string
    try { text = await fs.readFile(path, 'utf-8') } catch (e) { return `Error: ${(e as Error).message}` }
    const count = oldStr === '' ? 0 : text.split(oldStr).length - 1
    if (count === 0) return 'Error: old_string not found'
    if (count > 1 && !input?.replace_all) return `Error: old_string matches ${count} times — pass replace_all or make it unique`
    const next = input?.replace_all ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr)
    try { await fs.writeFile(path, next, 'utf-8') } catch (e) { return `Error: ${(e as Error).message}` }
    return `Edited ${path} (${input?.replace_all ? count : 1} replacement${(input?.replace_all ? count : 1) === 1 ? '' : 's'})`
  },
}

export const LsTool: CoreTool = {
  name: 'LS',
  description: 'List the entries in a directory.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute directory path' },
      all: { type: 'boolean', description: 'Include dotfiles', default: false },
    },
    required: ['path'],
  },
  async call(input) {
    const path = String(input?.path ?? '')
    if (!path) return 'Error: path required'
    let entries
    try { entries = await fs.readdir(path, { withFileTypes: true }) } catch (e) { return `Error: ${(e as Error).message}` }
    const rows: string[] = []
    for (const ent of entries) {
      if (!input?.all && ent.name.startsWith('.')) continue
      if (ent.isDirectory()) { rows.push(`${ent.name}/`); continue }
      let size = 0
      try { size = (await fs.stat(join(path, ent.name))).size } catch { /* ignore */ }
      rows.push(`${ent.name}\t${size}B`)
    }
    return rows.length ? rows.sort().join('\n') : '[empty directory]'
  },
}

/** The built-in core tools every turn gets. */
export const CORE_TOOLS: CoreTool[] = [ReadTool, WriteTool, EditTool, LsTool]
