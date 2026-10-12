/**
 * In-process {@link JobStore} - a single-process queue backed by a Map. Correct for dev and for a single
 * long-running server (Bun/Node/Deno). It is NOT durable (a restart loses pending jobs) and NOT safe
 * across multiple worker processes - bring a Redis/Postgres-backed store for that.
 *
 * Leasing model: a leased job is hidden until its `leaseUntil` passes, so a worker that dies mid-job
 * (never calling `complete`/`retry`) releases the job back to the queue automatically - at-least-once.
 * Every lease carries a fresh token; `complete`/`retry`/`deadLetter`/`renew` with a token that is no
 * longer the job's current one are ignored, so a worker whose lease was taken over cannot settle the
 * job under the worker that now holds it.
 */
import type { JobCounts, JobStore, StoredJob } from "./types.ts"

interface Record {
  readonly id: string
  readonly name: string
  readonly payload: unknown
  attempt: number
  readonly maxAttempts: number
  readonly traceparent: string | undefined
  runAt: number
  /** Epoch-ms until which this job is hidden (leased). 0 = available. */
  leaseUntil: number
  /** The current lease's token; `undefined` once the job is released. */
  lease: string | undefined
}

interface DeadRecord {
  readonly id: string
  readonly name: string
  readonly error: string
}

/** Construct an in-memory job store. `idFor` is injectable for deterministic tests. */
export class MemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, Record>()
  private readonly dead = new Map<string, DeadRecord>()
  private seq = 0
  private leaseSeq = 0
  private readonly idFor: () => string

  constructor(options: { idFor?: () => string } = {}) {
    this.idFor = options.idFor ?? (() => `job_${++this.seq}`)
  }

  enqueue(job: {
    name: string
    payload: unknown
    runAt: number
    maxAttempts: number
    traceparent?: string
  }): string {
    const id = this.idFor()
    this.jobs.set(id, {
      id,
      name: job.name,
      payload: job.payload,
      attempt: 0,
      maxAttempts: job.maxAttempts,
      traceparent: job.traceparent,
      runAt: job.runAt,
      leaseUntil: 0,
      lease: undefined,
    })
    return id
  }

  lease(now: number, limit: number, leaseMs: number): StoredJob[] {
    const out: StoredJob[] = []
    for (const r of this.jobs.values()) {
      if (out.length >= limit) break
      if (r.runAt <= now && r.leaseUntil <= now) {
        r.leaseUntil = now + leaseMs
        r.lease = String(++this.leaseSeq)
        const job: { -readonly [K in keyof StoredJob]: StoredJob[K] } = {
          id: r.id,
          name: r.name,
          payload: r.payload,
          attempt: r.attempt,
          maxAttempts: r.maxAttempts,
          lease: r.lease,
        }
        if (r.traceparent !== undefined) job.traceparent = r.traceparent
        out.push(job)
      }
    }
    return out
  }

  /** The job, when a call made under `lease` may still act on it (no token: any caller may). */
  private held(id: string, lease: string | undefined): Record | undefined {
    const r = this.jobs.get(id)
    return r === undefined || (lease !== undefined && r.lease !== lease) ? undefined : r
  }

  complete(id: string, lease?: string): void {
    if (this.held(id, lease) !== undefined) this.jobs.delete(id)
  }

  retry(id: string, runAt: number, lease?: string): void {
    const r = this.held(id, lease)
    if (r === undefined) return
    r.attempt += 1
    r.runAt = runAt
    r.leaseUntil = 0
    r.lease = undefined
  }

  deadLetter(id: string, error: string, lease?: string): void {
    const r = this.held(id, lease)
    if (r === undefined) return
    this.jobs.delete(id)
    this.dead.set(id, { id, name: r.name, error })
  }

  renew(id: string, until: number, lease?: string): void {
    const r = this.held(id, lease)
    if (r !== undefined && r.lease !== undefined) r.leaseUntil = until
  }

  counts(now: number = Date.now()): JobCounts {
    let pending = 0
    let active = 0
    for (const r of this.jobs.values()) {
      if (r.leaseUntil > now) active += 1
      else pending += 1
    }
    return { pending, active, dead: this.dead.size }
  }

  /** The dead-letter queue - inspect/requeue failed jobs (not part of the {@link JobStore} contract). */
  deadLetters(): DeadRecord[] {
    return [...this.dead.values()]
  }
}
