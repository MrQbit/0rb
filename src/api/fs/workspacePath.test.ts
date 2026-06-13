import { describe, test, expect } from 'bun:test'
import { safeJoinUnderWorkspace, WorkspaceEscapeError, isWorkspaceEscape } from './workspacePath.ts'

describe('safeJoinUnderWorkspace', () => {
  const ROOT = '/workspace'
  const SESSION = 'sess-abc'

  test('returns sessionId-based default when sub is empty/undefined/null', () => {
    expect(safeJoinUnderWorkspace(ROOT, undefined, SESSION)).toBe('/workspace/sess-abc')
    expect(safeJoinUnderWorkspace(ROOT, '', SESSION)).toBe('/workspace/sess-abc')
    expect(safeJoinUnderWorkspace(ROOT, '   ', SESSION)).toBe('/workspace/sess-abc')
    expect(safeJoinUnderWorkspace(ROOT, null, SESSION)).toBe('/workspace/sess-abc')
  })

  test('allows in-tree relative subpath', () => {
    expect(safeJoinUnderWorkspace(ROOT, 'proj1', SESSION)).toBe('/workspace/proj1')
    expect(safeJoinUnderWorkspace(ROOT, 'a/b/c', SESSION)).toBe('/workspace/a/b/c')
  })

  test('allows the root itself', () => {
    expect(safeJoinUnderWorkspace(ROOT, '.', SESSION)).toBe('/workspace')
  })

  test('rejects absolute path escape', () => {
    expect(() => safeJoinUnderWorkspace(ROOT, '/etc', SESSION)).toThrow(WorkspaceEscapeError)
    expect(() => safeJoinUnderWorkspace(ROOT, '/etc/passwd', SESSION)).toThrow(WorkspaceEscapeError)
  })

  test('rejects parent traversal', () => {
    expect(() => safeJoinUnderWorkspace(ROOT, '..', SESSION)).toThrow(WorkspaceEscapeError)
    expect(() => safeJoinUnderWorkspace(ROOT, '../etc', SESSION)).toThrow(WorkspaceEscapeError)
    expect(() => safeJoinUnderWorkspace(ROOT, 'proj/../../etc', SESSION)).toThrow(WorkspaceEscapeError)
  })

  test('error carries the attempted value and the WORKSPACE_ESCAPE code', () => {
    try {
      safeJoinUnderWorkspace(ROOT, '/etc/passwd', SESSION)
      throw new Error('expected throw')
    } catch (err) {
      expect(isWorkspaceEscape(err)).toBe(true)
      if (isWorkspaceEscape(err)) {
        expect(err.code).toBe('WORKSPACE_ESCAPE')
        expect(err.attempted).toBe('/etc/passwd')
      }
    }
  })

  test('isWorkspaceEscape returns false for unrelated errors', () => {
    expect(isWorkspaceEscape(new Error('nope'))).toBe(false)
    expect(isWorkspaceEscape(null)).toBe(false)
    expect(isWorkspaceEscape('string')).toBe(false)
  })
})
