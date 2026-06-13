/**
 * In-process job queue — executes SubmitJob payloads without RabbitMQ.
 * Used when RABBITMQ_URL is not configured (single-instance deployments).
 *
 * Jobs are held in memory; they're lost on restart. For persistent
 * scheduling, configure RabbitMQ or use an external scheduler.
 */
import { log } from '../log.js'

export type InprocJob = {
  id: string
  type: string
  description: string
  params: Record<string, unknown>
  sessionId: string
  ownerId: string
  enqueuedAt: string
}

type JobExecutor = (job: InprocJob) => Promise<void>

const queue: InprocJob[] = []
let executor: JobExecutor | null = null
let pollHandle: ReturnType<typeof setInterval> | null = null

export function pendingCount(): number {
  return queue.length
}

export function enqueue(job: InprocJob): void {
  queue.push(job)
  log.info('inproc_job_enqueued', { jobId: job.id, type: job.type })
}

export function setExecutor(fn: JobExecutor): void {
  executor = fn
}

async function processNext(): Promise<void> {
  if (!executor || queue.length === 0) return
  const job = queue.shift()!
  log.info('inproc_job_starting', { jobId: job.id, type: job.type })
  try {
    await executor(job)
    log.info('inproc_job_completed', { jobId: job.id })
  } catch (err) {
    log.error('inproc_job_failed', { jobId: job.id, error: (err as Error).message })
    // Don't requeue — log and drop to avoid infinite retry loops
  }
}

export function startPollLoop(intervalMs = 5_000): void {
  if (pollHandle) return
  pollHandle = setInterval(() => {
    processNext().catch(err =>
      log.error('inproc_poll_error', { error: (err as Error).message }),
    )
  }, intervalMs)
  // Don't prevent process exit
  if (typeof pollHandle === 'object' && pollHandle !== null && 'unref' in pollHandle) {
    (pollHandle as any).unref?.()
  }
  log.info('inproc_queue_started', { intervalMs })
}
