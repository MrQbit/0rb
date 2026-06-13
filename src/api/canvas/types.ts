/**
 * Canvas session types.
 *
 * A canvas session is a long-lived pod that runs a Vite dev server
 * alongside the agent. The pod persists across turns within the same
 * session, providing live preview with HMR while the agent edits files.
 */

export type CanvasTemplate = 'react-ts' | 'vue-ts' | 'vanilla-ts'

export type CanvasPodState =
  | 'creating'
  | 'running'
  | 'snapshotting'
  | 'terminated'

export type CanvasPodInfo = {
  sessionId: string
  podName: string
  podIp: string
  vitePort: number
  rpcPort: number
  state: CanvasPodState
  template: CanvasTemplate
  createdAt: string
  lastActivityAt: string
  snapshotUrl?: string
}

export type CanvasSessionConfig = {
  template: CanvasTemplate
  idleTimeoutMs: number
  resourceLimits: {
    cpuRequest: string
    cpuLimit: string
    memoryRequest: string
    memoryLimit: string
  }
  runtimeClassName?: string
}

export const DEFAULT_CANVAS_CONFIG: CanvasSessionConfig = {
  template: 'react-ts',
  idleTimeoutMs: 30 * 60 * 1000,
  resourceLimits: {
    cpuRequest: '250m',
    cpuLimit: '2',
    memoryRequest: '512Mi',
    memoryLimit: '2Gi',
  },
}
