import { randomUUID } from 'node:crypto'
import type { Store } from '../store/store.js'
import type { JobRecord, JobState, JobEvent } from './types.js'

const JOB_PREFIX = 'job:'
const JOB_SESSION_PREFIX = 'jobs:session:'
const JOB_TTL = 60 * 60 * 24 * 7 // 7 days

export class JobManager {
  constructor(private store: Store) {}

  async create(opts: {
    sessionId: string
    ownerId: string
    type: string
    description: string
    params: Record<string, unknown>
    requiresApproval: boolean
  }): Promise<JobRecord> {
    const id = `job-${randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()
    const record: JobRecord = {
      id,
      sessionId: opts.sessionId,
      ownerId: opts.ownerId,
      type: opts.type,
      description: opts.description,
      status: 'submitted',
      params: opts.params,
      requiresApproval: opts.requiresApproval,
      events: [{ ts: now, type: 'created', message: `Job ${id} created: ${opts.description}` }],
      createdAt: now,
      updatedAt: now,
    }
    await this.store.putKv(`${JOB_PREFIX}${id}`, JSON.stringify(record), JOB_TTL)
    // Index by session
    const sessionKey = `${JOB_SESSION_PREFIX}${opts.sessionId}`
    const existing = await this.store.getKv(sessionKey)
    const ids: string[] = existing ? JSON.parse(existing) : []
    ids.push(id)
    await this.store.putKv(sessionKey, JSON.stringify(ids), JOB_TTL)
    return record
  }

  async get(id: string): Promise<JobRecord | null> {
    const raw = await this.store.getKv(`${JOB_PREFIX}${id}`)
    return raw ? JSON.parse(raw) : null
  }

  async update(id: string, updates: Partial<Pick<JobRecord, 'status' | 'result' | 'pendingApproval'>>, event?: JobEvent): Promise<JobRecord | null> {
    const record = await this.get(id)
    if (!record) return null
    if (updates.status) record.status = updates.status
    if (updates.result !== undefined) record.result = updates.result
    if (updates.pendingApproval !== undefined) record.pendingApproval = updates.pendingApproval
    if (event) record.events.push(event)
    record.updatedAt = new Date().toISOString()
    await this.store.putKv(`${JOB_PREFIX}${id}`, JSON.stringify(record), JOB_TTL)
    return record
  }

  async listForSession(sessionId: string): Promise<JobRecord[]> {
    const raw = await this.store.getKv(`${JOB_SESSION_PREFIX}${sessionId}`)
    if (!raw) return []
    const ids: string[] = JSON.parse(raw)
    const jobs: JobRecord[] = []
    for (const id of ids) {
      const job = await this.get(id)
      if (job) jobs.push(job)
    }
    return jobs
  }

  async listPendingForSession(sessionId: string): Promise<JobRecord[]> {
    const all = await this.listForSession(sessionId)
    return all.filter(j =>
      j.status === 'submitted' ||
      j.status === 'running' ||
      j.status === 'awaiting_approval',
    )
  }

  async listRecentlyCompletedForSession(sessionId: string): Promise<JobRecord[]> {
    const all = await this.listForSession(sessionId)
    const fiveMinAgo = Date.now() - 5 * 60 * 1000
    return all.filter(j =>
      (j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled') &&
      new Date(j.updatedAt).getTime() > fiveMinAgo,
    )
  }

  async approve(id: string): Promise<JobRecord | null> {
    const now = new Date().toISOString()
    return this.update(id, {
      status: 'running',
      pendingApproval: undefined,
    }, {
      ts: now,
      type: 'approved',
      message: 'Approval granted, job resuming',
    })
  }

  async reject(id: string, reason?: string): Promise<JobRecord | null> {
    const now = new Date().toISOString()
    return this.update(id, {
      status: 'cancelled',
      pendingApproval: undefined,
    }, {
      ts: now,
      type: 'rejected',
      message: reason || 'Approval rejected',
    })
  }
}
