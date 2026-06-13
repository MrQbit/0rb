/**
 * Workspace path containment.
 *
 * Every handler that accepts a client-supplied `working_directory`
 * MUST resolve it through `safeJoinUnderWorkspace()`. The function
 * resolves to an absolute path and refuses anything that escapes
 * `workspaceRoot` — including absolute paths (which `path.resolve`
 * would otherwise honor as the new base) and any `..` traversal.
 */
import path from 'node:path'

export class WorkspaceEscapeError extends Error {
  readonly code = 'WORKSPACE_ESCAPE'
  constructor(public readonly attempted: string) {
    super(`working_directory escapes workspace root: ${attempted}`)
  }
}

export function safeJoinUnderWorkspace(
  workspaceRoot: string,
  sub: string | undefined | null,
  sessionId: string,
): string {
  const absRoot = path.resolve(workspaceRoot)
  const trimmed = typeof sub === 'string' ? sub.trim() : ''
  if (!trimmed) {
    return path.join(absRoot, sessionId)
  }
  const resolved = path.resolve(absRoot, trimmed)
  if (resolved !== absRoot && !resolved.startsWith(absRoot + path.sep)) {
    throw new WorkspaceEscapeError(trimmed)
  }
  return resolved
}

export function isWorkspaceEscape(err: unknown): err is WorkspaceEscapeError {
  return err instanceof WorkspaceEscapeError
}
