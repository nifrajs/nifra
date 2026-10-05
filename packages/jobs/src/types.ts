/**
 * @nifrajs/jobs - types for the typed background-job queue.
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

/**
 * The trace an instrumented attempt runs in. It has the shape of `c.trace` from `@nifrajs/otel`, so
 * `cache.for(ctx)` and a nested `job.for(ctx).enqueue()` inside the handler stay in the same trace.
 */
export interface JobTraceContext {
  readonly traceId: string
  readonly spanId: string
  readonly sampled: boolean
  /** W3C `traceparent` of the attempt's span. */
  readonly traceparent: string
}

/** What a handler receives alongside the payload: identity + which attempt this is (1-based). */
export interface JobContext {
  readonly id: string
  readonly name: string
  /** 1 on the first run, 2 on the first retry, … */
  readonly attempt: number
  /** Set when the queue's `instrument.run` opened a span for this attempt (see `jobTracing()`). */
  readonly trace?: JobTraceContext
}

/** A job processor. A throw/rejection routes to `onError` and triggers retry/dead-letter - never crashes the worker. */
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
  /** Optional Standard Schema - validates the payload at `enqueue` (the trust boundary); a failure throws. */
  readonly input?: StandardSchemaV1<Payload>
  /** `number` is shorthand for `{ attempts }`. */
  readonly retries?: number | RetryPolicy
}

/**
 * `useCapability` from `@nifrajs/core/capabilities`, taken as a parameter rather than imported so this
 * package keeps its zero dependencies. Wiring it is one line where the queue is created.
 */
export type CapabilityBeacon = (context: object, capability: string) => void

/** A typed handle to enqueue a defined job. */
export interface JobHandle<Payload> {
  readonly name: string
  enqueue(payload: Payload, options?: EnqueueOptions): Promise<string>
  /**
   * A handle bound to a request (or job) context. With a `beacon` on the queue, `enqueue` announces its
   * capability first and fails closed when the route did not declare it - evidence from the CALL is
   * per-route and exact, where evidence from an import is as broad as the module that holds it. The
   * context's `trace.traceparent` (from `tracing()`, or `JobContext.trace`) is stored with the job, so
   * the run continues the producer's trace.
   *
   * Requires `beacon` or `instrument` on the queue. With neither this throws rather than handing back a
   * handle that quietly produces no evidence.
   */
  for(context: object): JobHandle<Payload>
}

export interface EnqueueOptions {
  /** Delay before the job becomes eligible. Ignored if `runAt` is set. */
  readonly delayMs?: number
  /** Absolute epoch-ms eligibility time. Overrides `delayMs`. */
  readonly runAt?: number
  /**
   * The producer's W3C `traceparent`, for an enqueue outside a request (a cron tick, a script).
   * Overrides the bound context's trace. A value that is not a well-formed traceparent is dropped.
   */
  readonly traceparent?: string
}

/** What `instrument.enqueue` sees. */
export interface JobEnqueueInfo {
  readonly name: string
  /** The producer's `traceparent` (bound context or {@link EnqueueOptions.traceparent}), if any. */
  readonly traceparent: string | undefined
}

/** What `instrument.run` sees for one attempt. */
export interface JobRunInfo {
  readonly id: string
  readonly name: string
  /** 1-based, as on {@link JobContext}. */
  readonly attempt: number
  readonly maxAttempts: number
  /** The `traceparent` stored with the job. It came back from the store: parse it before trusting it. */
  readonly traceparent: string | undefined
}

/** How an attempt ended: removed, rescheduled, or moved to the dead-letter set. */
export type JobRunOutcome = "completed" | "retried" | "dead-lettered"

/**
 * Around-hooks for tracing (or timing) the queue - the seam `jobTracing()` from `@nifrajs/otel/jobs`
 * plugs into. Each hook calls `next` once and returns what it resolves to. A hook that throws, or never
 * calls `next`, cannot change behavior: the work still runs, uninstrumented.
 */
export interface QueueInstrument {
  /**
   * Wraps one enqueue (payload validation + the store write). `next({ traceparent })` stores that trace
   * context with the job instead of the producer's - the producer span's own context, so the run can
   * be its child - and resolves to the job id.
   */
  enqueue?(
    info: JobEnqueueInfo,
    next: (scope?: { readonly traceparent?: string }) => Promise<string>,
  ): Promise<unknown>
  /**
   * Wraps one attempt. `next({ trace })` runs the handler with `ctx.trace` set, settles the job in the
   * store, and resolves to the outcome; it rejects only when the store itself fails.
   */
  run?(
    info: JobRunInfo,
    next: (scope?: { readonly trace?: JobTraceContext }) => Promise<JobRunOutcome>,
  ): Promise<unknown>
}

// ── Store contract ────────────────────────────────────────────────────────────────────────────────

/** A job as handed back by {@link JobStore.lease}. `attempt` is the count of PRIOR attempts (0 the first time). */
export interface StoredJob {
  readonly id: string
  readonly name: string
  readonly payload: unknown
  readonly attempt: number
  readonly maxAttempts: number
  /**
   * The producer's W3C `traceparent`, as given to {@link JobStore.enqueue}. A store that does not
   * persist it still runs every job; only the link between the producer's and the run's spans is lost.
   */
  readonly traceparent?: string
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
 * workers. All methods may be sync or async - the queue awaits them.
 */
export interface JobStore {
  /** Persist a new job; return its id. Hand `traceparent` back on {@link StoredJob} when present. */
  enqueue(job: {
    name: string
    payload: unknown
    runAt: number
    maxAttempts: number
    traceparent?: string
  }): string | Promise<string>
  /** Atomically claim up to `limit` jobs due at/before `now`, hiding them for `leaseMs`. */
  lease(now: number, limit: number, leaseMs: number): StoredJob[] | Promise<StoredJob[]>
  /** A job finished successfully - remove it. */
  complete(id: string): void | Promise<void>
  /** A job failed but has attempts left - bump its attempt count and reschedule for `runAt`. */
  retry(id: string, runAt: number): void | Promise<void>
  /** A job exhausted its attempts - move it to the dead-letter set with the last error. */
  deadLetter(id: string, error: string): void | Promise<void>
  /** Snapshot counts (observability + tests). */
  counts(): JobCounts | Promise<JobCounts>
}
