import { randomUUID } from 'node:crypto'
import { JobManager } from './manager.js'
import { publishToFabric } from './rabbit.js'
import { enqueue as inprocEnqueue } from './inprocQueue.js'
import type { FabricMessageEnvelope } from './types.js'
import type { Store } from '../store/store.js'

let _jobManager: JobManager | null = null

export function getJobManager(store: Store): JobManager {
  if (!_jobManager) _jobManager = new JobManager(store)
  return _jobManager
}

export type SubmitJobInput = {
  type: string
  description: string
  params?: Record<string, unknown>
  requires_approval?: boolean
}

export type SubmitJobResult = {
  jobId: string
  status: string
  message: string
  requiresApproval: boolean
}

export async function executeSubmitJob(
  input: SubmitJobInput,
  context: { sessionId: string; ownerId: string; store: Store },
): Promise<SubmitJobResult> {
  const manager = getJobManager(context.store)

  const job = await manager.create({
    sessionId: context.sessionId,
    ownerId: context.ownerId,
    type: input.type,
    description: input.description,
    params: input.params || {},
    requiresApproval: input.requires_approval !== false,
  })

  // Publish to Fabric AG-UI server via RabbitMQ
  const envelope: FabricMessageEnvelope = {
    messageId: randomUUID(),
    messageType: input.requires_approval !== false ? 'task.status.updated' : 'task.result.ready',
    correlationId: job.id,
    messageVersion: '1.0',
    messageTimestamp: new Date().toISOString(),
    source: 'rak00n-api',
    body: {
      userId: context.ownerId,
      contextId: context.sessionId,
      rootTaskId: job.id,
      message: job.description,
      messageId: randomUUID(),
      agentResponseId: randomUUID(),
      state: input.requires_approval !== false ? 'input-required' : 'submitted',
      agentId: 'rak00n',
      timestamp: new Date().toISOString(),
      metadata: {
        jobType: job.type,
        params: job.params,
        requiresApproval: job.requiresApproval,
      },
    },
  }

  const published = await publishToFabric(envelope)

  // When RabbitMQ is not available, fall back to the in-process queue
  // so jobs actually execute in single-instance deployments.
  if (!published) {
    inprocEnqueue({
      id: job.id,
      type: job.type,
      description: job.description,
      params: job.params,
      sessionId: context.sessionId,
      ownerId: context.ownerId,
      enqueuedAt: new Date().toISOString(),
    })
  }

  if (job.requiresApproval) {
    await manager.update(job.id, {
      status: 'awaiting_approval',
      pendingApproval: {
        id: `approval-${job.id}`,
        reason: 'confirmation',
        message: `Approval required for: ${job.description}`,
      },
    }, {
      ts: new Date().toISOString(),
      type: 'approval_requested',
      message: `Job awaiting approval. RabbitMQ published: ${published}`,
    })
  }

  return {
    jobId: job.id,
    status: job.requiresApproval ? 'awaiting_approval' : 'submitted',
    message: published
      ? `Job ${job.id} submitted and published to Fabric queue. ${job.requiresApproval ? 'Awaiting external approval. Add this to your todo list and check status on subsequent messages.' : ''}`
      : `Job ${job.id} submitted (RabbitMQ not connected -- job stored locally only). ${job.requiresApproval ? 'Awaiting approval via API.' : ''}`,
    requiresApproval: job.requiresApproval,
  }
}

export const SUBMIT_JOB_TOOL_DEF = {
  name: 'SubmitJob',
  description: 'Submit an async job that requires external processing or approval. Use when a user requests a deployment, workflow, or any operation that needs approval or long-running background execution. The job will be tracked and you should add it to your todo list.',
  input_schema: {
    type: 'object' as const,
    properties: {
      type: {
        type: 'string' as const,
        description: 'Job type: fabric-deploy, code-review, workflow, pipeline, infrastructure, etc.',
      },
      description: {
        type: 'string' as const,
        description: 'Human-readable description of what this job does',
      },
      params: {
        type: 'object' as const,
        description: 'Job-specific parameters (app name, environment, branch, etc.)',
      },
      requires_approval: {
        type: 'boolean' as const,
        description: 'Whether this job needs external approval before execution. Default: true',
      },
    },
    required: ['type', 'description'],
  },
}
