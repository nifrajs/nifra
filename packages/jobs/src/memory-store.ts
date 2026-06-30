/**
 * In-process {@link JobStore} — a single-process queue backed by a Map. Correct for dev and for a single
 * long-running server (Bun/Node/Deno). It is NOT durable (a restart loses pending jobs) and NOT safe
 * across multiple worker processes — bring a Redis/Postgres-backed store for that.
 *
 * Leasing model: a leased job is hidden until its `leaseUntil` passes, so a worker that dies mid-job
 * (never calling `complete`/`retry`) releases the job back to the queue automatically — at-least-once.
 */
import type { JobCounts, JobStore, StoredJob } from "./types.ts"

interface Record {
  readonly id: string
  readonly name: string
  readonly payload: unknown
  attempt: number
  readonly maxAttempts: number
  runAt: number
  /** Epoch-ms until which this job is hidden (leased). 0 = available. */
  leaseUntil: number
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
  private readonly idFor: () => string

  constructor(options: { idFor?: () => string } = {}) {
    this.idFor = options.idFor ?? (() => `job_${++this.seq}`)
  }

  enqueue(job: { name: string; payload: unknown; runAt: number; maxAttempts: number }): string {
    const id = this.idFor()
    this.jobs.set(id, {
      id,
      name: job.name,
      payload: job.payload,
      attempt: 0,
      maxAttempts: job.maxAttempts,
      runAt: job.runAt,
      leaseUntil: 0,
    })
    return id
  }

  lease(now: number, limit: number, leaseMs: number): StoredJob[] {
    const out: StoredJob[] = []
    for (const r of this.jobs.values()) {
      if (out.length >= limit) break
      if (r.runAt <= now && r.leaseUntil <= now) {
        r.leaseUntil = now + leaseMs
        out.push({
          id: r.id,
          name: r.name,
          payload: r.payload,
          attempt: r.attempt,
          maxAttempts: r.maxAttempts,
        })
      }
    }
    return out
  }

  complete(id: string): void {
    this.jobs.delete(id)
  }

  retry(id: string, runAt: number): void {
    const r = this.jobs.get(id)
    if (r === undefined) return
    r.attempt += 1
    r.runAt = runAt
    r.leaseUntil = 0
  }

  deadLetter(id: string, error: string): void {
    const r = this.jobs.get(id)
    if (r === undefined) return
    this.jobs.delete(id)
    this.dead.set(id, { id, name: r.name, error })
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

  /** The dead-letter queue — inspect/requeue failed jobs (not part of the {@link JobStore} contract). */
  deadLetters(): DeadRecord[] {
    return [...this.dead.values()]
  }
}
