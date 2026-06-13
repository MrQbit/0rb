export type JobState =
  | 'submitted'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type JobEvent = {
  ts: string
  type: 'created' | 'status_change' | 'progress' | 'approval_requested' | 'approved' | 'rejected' | 'error'
  message: string
  data?: Record<string, unknown>
}

export type JobRecord = {
  id: string
  sessionId: string
  ownerId: string
  type: string
  description: string
  status: JobState
  params: Record<string, unknown>
  requiresApproval: boolean
  result?: unknown
  events: JobEvent[]
  pendingApproval?: {
    id: string
    reason: string
    message: string
  }
  createdAt: string
  updatedAt: string
}

/**
 * Fabric Next AG-UI Server message envelope format.
 * Matches MessageEnvelope<AgentMessage> from fabric-nxt-agui-server.
 */
export type FabricMessageEnvelope = {
  messageId: string
  messageType: string
  correlationId?: string
  messageVersion: string
  messageTimestamp: string
  source: string
  body: FabricAgentMessage
}

export type FabricAgentMessage = {
  userId?: string
  contextId?: string
  rootTaskId?: string
  message: string
  messageId?: string
  agentResponseId?: string
  state?: string
  agentId: string
  correlationId?: string
  timestamp: string
  metadata?: Record<string, unknown>
}
