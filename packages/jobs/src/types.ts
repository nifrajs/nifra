/**
 * @nifrajs/jobs — types for the typed background-job queue.
 *
 * Dependency-free: the Standard Schema surface below is the public spec, declared structurally so
 * `define({ input })` can validate + infer a payload from any Standard-Schema validator (e.g.
 * `@nifrajs/schema`'s `t`) without importing it. The queue owns scheduling/retries; the {@link JobStore}
 * owns persistence (memory in dev; bring a durable store for production).
 */

/** The validate-result half of the Standard Schema spec. */
export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string }> }

/** A minimal structural view of a Standard Schema validator (v1). `t.object(...)` satisfies it. */
export interface StandardSchemaV1<Output = unknown> {
  readonly "~standard": {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>
    readonly types?: { readonly input: unknown; readonly output: Output }
  }
}

/** What a handler receives alongside the payload: identity + which attempt this is (1-based). */
export interface JobContext {
  readonly id: string
  readonly name: string
  /** 1 on the first run, 2 on the first retry, … */
  readonly attempt: number
}

/** A job processor. A throw/rejection routes to `onError` and triggers retry/dead-letter — never crashes the worker. */
export type JobHandler<Payload> = (payload: Payload, ctx: JobContext) => void | Promise<void>

/** ms to wait before the next attempt, given the number of attempts already made (1-based). */
export type Backoff = (attempt: number) => number

export interface RetryPolicy {
  /** Total attempts before dead-lettering (incl. the first). Default 3. `1` = no retries. */
  readonly attempts: number
  /** Delay before each retry. Default {@link exponentialBackoff}. */
  readonly backoff?: Backoff
}

/** A job definition registered on a queue. */
export interface JobDefinition<Payload> {
  readonly handler: JobHandler<Payload>
  /** Optional Standard Schema — validates the payload at `enqueue` (the trust boundary); a failure throws. */
  readonly input?: StandardSchemaV1<Payload>
  /** `number` is shorthand for `{ attempts }`. */
  readonly retries?: number | RetryPolicy
}

/** A typed handle to enqueue a defined job. */
export interface JobHandle<Payload> {
  readonly name: string
  enqueue(payload: Payload, options?: EnqueueOptions): Promise<string>
}

export interface EnqueueOptions {
  /** Delay before the job becomes eligible. Ignored if `runAt` is set. */
  readonly delayMs?: number
  /** Absolute epoch-ms eligibility time. Overrides `delayMs`. */
  readonly runAt?: number
}

// ── Store contract ────────────────────────────────────────────────────────────────────────────────

/** A job as handed back by {@link JobStore.lease}. `attempt` is the count of PRIOR attempts (0 the first time). */
export interface StoredJob {
  readonly id: string
  readonly name: string
  readonly payload: unknown
  readonly attempt: number
  readonly maxAttempts: number
}

export interface JobCounts {
  /** Eligible or waiting, not currently leased. */
  readonly pending: number
  /** Leased and in flight. */
  readonly active: number
  /** Dead-lettered (exhausted retries). */
  readonly dead: number
}

/**
 * Persistence + leasing for the queue. The default {@link MemoryJobStore} is single-process (dev / a
 * single long-running server); implement this over Redis/Postgres/etc. for durability or multiple
 * workers. All methods may be sync or async — the queue awaits them.
 */
export interface JobStore {
  /** Persist a new job; return its id. */
  enqueue(job: {
    name: string
    payload: unknown
    runAt: number
    maxAttempts: number
  }): string | Promise<string>
  /** Atomically claim up to `limit` jobs due at/before `now`, hiding them for `leaseMs`. */
  lease(now: number, limit: number, leaseMs: number): StoredJob[] | Promise<StoredJob[]>
  /** A job finished successfully — remove it. */
  complete(id: string): void | Promise<void>
  /** A job failed but has attempts left — bump its attempt count and reschedule for `runAt`. */
  retry(id: string, runAt: number): void | Promise<void>
  /** A job exhausted its attempts — move it to the dead-letter set with the last error. */
  deadLetter(id: string, error: string): void | Promise<void>
  /** Snapshot counts (observability + tests). */
  counts(): JobCounts | Promise<JobCounts>
}
