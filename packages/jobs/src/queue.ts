/**
 * The queue - typed `define`/`enqueue` over a {@link JobStore}, plus an in-process worker that leases due
 * jobs and runs them with bounded concurrency. Mirrors `@nifrajs/cron`'s shape: a factory, an injectable
 * clock for deterministic tests, error isolation (a throw never tears down the loop), and a graceful
 * `stop()` that drains the in-flight round.
 *
 *   import { createQueue } from "@nifrajs/jobs"
 *   import { t } from "@nifrajs/schema"
 *
 *   const q = createQueue()
 *   const email = q.define("send-email", {
 *     input: t.object({ to: t.string() }),        // validated at enqueue
 *     retries: { attempts: 5 },
 *     async handler({ to }, ctx) { await send(to) },
 *   })
 *   await email.enqueue({ to: "a@b.com" }, { delayMs: 1000 })
 *   const worker = q.start({ concurrency: 4 })     // Bun/Node/Deno; on Workers use CF Queues (see README)
 *   // on shutdown: await worker.stop()
 *
 * For Cloudflare Workers (no long-lived process) drive a durable store from a CF Queues consumer instead
 * of `start()` - `await q.process()` inside the `queue()` handler. See the README.
 */
import { exponentialBackoff } from "./backoff.ts"
import { MemoryJobStore } from "./memory-store.ts"
import type {
  Backoff,
  CapabilityBeacon,
  EnqueueOptions,
  JobContext,
  JobCounts,
  JobDefinition,
  JobHandle,
  JobHandler,
  JobRunOutcome,
  JobStore,
  JobTraceContext,
  QueueInstrument,
  RetryPolicy,
  StandardSchemaV1,
  StoredJob,
} from "./types.ts"

/** Thrown for a misuse of the queue API (duplicate/unknown job name). */
export class JobError extends Error {
  override readonly name = "JobError"
}

/** Thrown by `enqueue` when the payload fails the job's `input` schema (validation at the trust boundary). */
export class JobValidationError extends Error {
  override readonly name = "JobValidationError"
  constructor(
    readonly job: string,
    readonly issues: ReadonlyArray<{ readonly message: string }>,
  ) {
    super(
      `job ${JSON.stringify(job)} payload is invalid: ${issues.map((i) => i.message).join("; ")}`,
    )
  }
}

/** What an attempt that outran its job's `timeoutMs` fails with; the attempt's `ctx.signal` aborts with it. */
export class JobTimeoutError extends Error {
  override readonly name = "JobTimeoutError"
  constructor(
    readonly job: string,
    readonly timeoutMs: number,
  ) {
    super(`job ${JSON.stringify(job)} did not finish within ${timeoutMs}ms`)
  }
}

export interface QueueOptions {
  /** Persistence. Default: a fresh {@link MemoryJobStore} (single-process). */
  readonly store?: JobStore
  /** Called when a handler throws (before retry/dead-letter). Default: `console.error`. A throwing handler here is swallowed. */
  readonly onError?: (error: unknown, jobName: string) => void
  /** Injectable clock (tests). Default `() => Date.now()`. */
  readonly now?: () => number
  /** Default attempts for jobs that don't set `retries`: a whole number (below 1 counts as 1).
   * Default 3. `createQueue` throws a `RangeError` on anything else. */
  readonly defaultAttempts?: number
  /** Default backoff for jobs that don't set one. Default {@link exponentialBackoff}. */
  readonly backoff?: Backoff
  /**
   * Make `enqueue` produce capability evidence:
   *
   *   import { useCapability } from "@nifrajs/core/capabilities"
   *   const queue = createQueue({ beacon: useCapability })
   *   await indexNote.for(c).enqueue({ id })
   */
  readonly beacon?: CapabilityBeacon
  /** Override the announced token. Default `jobs.enqueue`. */
  readonly capabilities?: { readonly enqueue?: string }
  /**
   * Around-hooks for each enqueue and each attempt - pass `jobTracing()` from `@nifrajs/otel/jobs` for a
   * `send <job>` producer span and a `process <job>` consumer span per attempt.
   */
  readonly instrument?: QueueInstrument
}

export interface WorkerOptions {
  /** Max jobs in flight at once. Default 1. A slot frees as soon as its job settles, and the next poll fills it. */
  readonly concurrency?: number
  /** How often to poll the store for due jobs (ms). Default 250. */
  readonly pollIntervalMs?: number
  /** How long a leased job is hidden before it's considered abandoned and re-leased (ms). Default
   * 30_000. A store with `renew` keeps a running job's lease alive; every job's `timeoutMs` must be
   * below it. */
  readonly leaseMs?: number
  /** Called when a poll round fails (the store's `lease` threw) or a lease renewal fails; polling
   * continues on the next tick. Default: `console.error`. A throwing handler here is swallowed. */
  readonly onPollError?: (error: unknown) => void
}

export interface Worker {
  /** Stop polling and await every job in flight (graceful). */
  stop(): Promise<void>
  readonly running: boolean
}

function assertWorkerOptions(options: WorkerOptions): void {
  if (
    options.concurrency !== undefined &&
    (!Number.isSafeInteger(options.concurrency) || options.concurrency <= 0)
  ) {
    throw new RangeError("jobs: concurrency must be a finite positive safe integer")
  }
  if (
    options.pollIntervalMs !== undefined &&
    (!Number.isFinite(options.pollIntervalMs) || options.pollIntervalMs < 0)
  ) {
    throw new RangeError("jobs: pollIntervalMs must be a finite non-negative number")
  }
  if (
    options.leaseMs !== undefined &&
    (!Number.isFinite(options.leaseMs) || options.leaseMs <= 0)
  ) {
    throw new RangeError("jobs: leaseMs must be a finite positive number")
  }
}

export interface Queue {
  /** Register a typed job. Throws now (not at run time) on a duplicate name. */
  define<Payload>(name: string, definition: JobDefinition<Payload>): JobHandle<Payload>
  /** Enqueue by name (the {@link JobHandle} is the typed alternative). */
  enqueue(name: string, payload: unknown, options?: EnqueueOptions): Promise<string>
  /** Run ONE poll round: lease due jobs into the free slots (up to `concurrency`), run them, await them.
   * Returns the count run. With nothing new to start it awaits the jobs already in flight instead.
   * Slots are shared with the worker and concurrent calls, so no more than `concurrency` jobs run. */
  process(): Promise<number>
  /** Process repeatedly until no job is due and none is in flight (one-shot batch drain). */
  drain(): Promise<number>
  /** Start the background worker (Bun/Node/Deno). */
  start(options?: WorkerOptions): Worker
  /** Current store counts. */
  counts(): JobCounts | Promise<JobCounts>
  /** The underlying store (for dead-letter inspection, custom drivers). */
  readonly store: JobStore
}

interface Def {
  readonly handler: JobHandler<unknown>
  // Explicit `| undefined` (not `?`) so the object literal can carry an absent schema under
  // exactOptionalPropertyTypes - the value is genuinely "schema or none", not a maybe-present key.
  readonly input: StandardSchemaV1 | undefined
  readonly attempts: number
  readonly backoff: Backoff
  readonly timeoutMs: number | undefined
}

/** A whole number of attempts, at least 1. `NaN` would make `attempt >= maxAttempts` never true, so a
 * failing job would retry forever instead of dead-lettering. */
function attemptCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`jobs: ${label} must be a whole number of attempts, got ${String(value)}`)
  }
  return Math.max(1, value)
}

function normalizeRetries(
  retries: number | RetryPolicy | undefined,
  defaultAttempts: number,
  defaultBackoff: Backoff,
): { attempts: number; backoff: Backoff } {
  if (retries === undefined) return { attempts: defaultAttempts, backoff: defaultBackoff }
  if (typeof retries === "number")
    return { attempts: attemptCount(retries, "retries"), backoff: defaultBackoff }
  return {
    attempts: attemptCount(retries.attempts, "retries.attempts"),
    backoff: retries.backoff ?? defaultBackoff,
  }
}

function assertTimeoutBelowLease(
  name: string,
  timeoutMs: number | undefined,
  leaseMs: number,
): void {
  if (timeoutMs !== undefined && timeoutMs >= leaseMs) {
    throw new RangeError(
      `jobs: job ${JSON.stringify(name)} timeoutMs (${timeoutMs}) must be below the worker's leaseMs (${leaseMs}), or its job can be leased again while the attempt still runs`,
    )
  }
}

/** A job this queue is running, by id: the lease it runs under, which a re-lease of the same job
 * replaces and a renewal extends. */
interface Hold {
  lease: string | undefined
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A store compares eligibility with `<=`, which is never true for `NaN`: such a job is never leased,
 * retried or dead-lettered. Refused before it is written. */
function eligibleTime(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(
      `jobs: ${label} must be a finite number of milliseconds, got ${String(value)}`,
    )
  }
  return value
}

const TRACEPARENT = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/

// A shape check only, to keep arbitrary strings out of the store; the tracer parses it properly.
const traceparentOrUndefined = (value: unknown): string | undefined =>
  typeof value === "string" && value.length === 55 && TRACEPARENT.test(value) ? value : undefined

function contextTraceparent(context: object): string | undefined {
  if (!("trace" in context)) return undefined
  const trace = context.trace
  return typeof trace === "object" && trace !== null && "traceparent" in trace
    ? traceparentOrUndefined(trace.traceparent)
    : undefined
}

// Marked handled at creation: a hook may drop the promise `next` returns, and an unobserved
// rejection would end a Node process before the queue awaits it.
function handled<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined)
  return promise
}

const lateNext = (hook: string): Promise<never> =>
  handled(Promise.reject(new JobError(`instrument.${hook} called next() after it returned`)))

// setTimeout clamps a longer delay to 1ms.
const MAX_TIMEOUT_MS = 2_147_483_647

function bounded(
  handler: JobHandler<unknown>,
  payload: unknown,
  context: JobContext,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController()
  const run = (async () => handler(payload, { ...context, signal: controller.signal }))()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new JobTimeoutError(context.name, timeoutMs)
      controller.abort(error)
      reject(error)
    }, timeoutMs)
  })
  return Promise.race([run, expired]).finally(() => clearTimeout(timer))
}

/** Create a job queue. Define jobs, enqueue payloads, and `start()` a worker (or `drain()` once). */
export function createQueue(options: QueueOptions = {}): Queue {
  const store = options.store ?? new MemoryJobStore()
  const now = options.now ?? (() => Date.now())
  const onError =
    options.onError ??
    ((error, name) => console.error(`[nifra/jobs] job ${JSON.stringify(name)} failed:`, error))
  const defaultAttempts =
    options.defaultAttempts === undefined
      ? 3
      : attemptCount(options.defaultAttempts, "defaultAttempts")
  const defaultBackoff = options.backoff ?? exponentialBackoff()
  const enqueueToken = options.capabilities?.enqueue ?? "jobs.enqueue"
  const instrument = options.instrument
  const defs = new Map<string, Def>()

  let timer: ReturnType<typeof setInterval> | undefined
  let concurrency = 1
  let leaseMs = 30_000
  const running = new Set<Promise<void>>()
  const holds = new Map<string, Hold>()
  let leasing: Promise<readonly Promise<void>[]> | undefined
  // `start()`'s poll-error reporter; until a worker starts, a failed renewal is logged.
  let reportRenewal: ((error: unknown) => void) | undefined

  const safeOnError = (error: unknown, name: string): void => {
    try {
      onError(error, name)
    } catch {
      /* a throwing onError must not crash the worker */
    }
  }

  async function validate(
    name: string,
    schema: StandardSchemaV1 | undefined,
    payload: unknown,
  ): Promise<unknown> {
    if (schema === undefined) return payload
    const result = await schema["~standard"].validate(payload)
    if (result.issues !== undefined) throw new JobValidationError(name, result.issues)
    return result.value
  }

  function define<Payload>(name: string, definition: JobDefinition<Payload>): JobHandle<Payload> {
    if (defs.has(name)) throw new JobError(`duplicate job ${JSON.stringify(name)}`)
    const timeoutMs = definition.timeoutMs
    if (
      timeoutMs !== undefined &&
      (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS)
    ) {
      throw new RangeError(
        `jobs: timeoutMs must be a positive number of ms up to ${MAX_TIMEOUT_MS}`,
      )
    }
    if (timer !== undefined) assertTimeoutBelowLease(name, timeoutMs, leaseMs)
    const { attempts, backoff } = normalizeRetries(
      definition.retries,
      defaultAttempts,
      defaultBackoff,
    )
    defs.set(name, {
      handler: definition.handler as JobHandler<unknown>,
      input: definition.input,
      attempts,
      backoff,
      timeoutMs,
    })
    const handle: JobHandle<Payload> = {
      name,
      enqueue: (payload, opts) => enqueue(name, payload, opts, undefined),
      for(context) {
        const beacon = options.beacon
        if (beacon === undefined && instrument === undefined) {
          throw new Error(
            "@nifrajs/jobs: for(context) needs a beacon or an instrument - pass `beacon: useCapability` (from @nifrajs/core/capabilities) or `instrument` to createQueue",
          )
        }
        return {
          ...handle,
          // A refused capability surfaces as a REJECTION, not a synchronous throw: `enqueue` returns a
          // promise, so a caller using `.catch(…)` rather than `try` would otherwise miss it entirely.
          enqueue: (payload, opts) => {
            try {
              beacon?.(context, enqueueToken)
            } catch (error) {
              return Promise.reject(error)
            }
            return enqueue(name, payload, opts, contextTraceparent(context))
          },
        }
      },
    }
    return handle
  }

  async function write(
    name: string,
    def: Def,
    payload: unknown,
    opts: EnqueueOptions,
    traceparent: string | undefined,
  ): Promise<string> {
    const value = await validate(name, def.input, payload)
    const runAt =
      opts.runAt !== undefined
        ? eligibleTime(opts.runAt, "runAt")
        : now() + Math.max(0, eligibleTime(opts.delayMs ?? 0, "delayMs"))
    const job = { name, payload: value, runAt, maxAttempts: def.attempts }
    return await store.enqueue(traceparent === undefined ? job : { ...job, traceparent })
  }

  async function enqueue(
    name: string,
    payload: unknown,
    opts: EnqueueOptions = {},
    contextTrace: string | undefined,
  ): Promise<string> {
    const def = defs.get(name)
    if (def === undefined)
      throw new JobError(`unknown job ${JSON.stringify(name)} - define it first`)
    const traceparent = traceparentOrUndefined(opts.traceparent) ?? contextTrace
    const hook = instrument?.enqueue
    if (hook === undefined) return await write(name, def, payload, opts, traceparent)
    let written: Promise<string> | undefined
    let closed = false
    const next = (scope?: { readonly traceparent?: string }): Promise<string> => {
      if (closed) return lateNext("enqueue")
      written ??= handled(
        write(name, def, payload, opts, traceparentOrUndefined(scope?.traceparent) ?? traceparent),
      )
      return written
    }
    try {
      await hook.call(instrument, { name, traceparent }, next)
    } catch {
      // The instrument cannot change the result; a rejection of `next` itself surfaces below.
    }
    closed = true
    return await (written ?? write(name, def, payload, opts, traceparent))
  }

  async function attemptJob(
    job: StoredJob,
    hold: Hold,
    def: Def,
    attempt: number,
    trace: JobTraceContext | undefined,
  ): Promise<JobRunOutcome> {
    try {
      const context: JobContext =
        trace === undefined
          ? { id: job.id, name: job.name, attempt }
          : { id: job.id, name: job.name, attempt, trace }
      await (def.timeoutMs === undefined
        ? def.handler(job.payload, context)
        : bounded(def.handler, job.payload, context, def.timeoutMs))
    } catch (err) {
      safeOnError(err, job.name)
      if (attempt >= job.maxAttempts) {
        await store.deadLetter(job.id, errText(err), hold.lease)
        return "dead-lettered"
      }
      const delay = def.backoff(attempt)
      if (!Number.isFinite(delay)) {
        // Rescheduled at NaN or Infinity, the job would never run again and never dead-letter.
        const invalid = new RangeError(
          `jobs: backoff for ${JSON.stringify(job.name)} returned ${String(delay)} after attempt ${attempt}, not a finite delay`,
        )
        safeOnError(invalid, job.name)
        await store.deadLetter(job.id, `${errText(err)}; ${invalid.message}`, hold.lease)
        return "dead-lettered"
      }
      await store.retry(job.id, now() + Math.max(0, delay), hold.lease)
      return "retried"
    }
    // Outside the try: a store that fails to record a success must not retry or dead-letter a job
    // whose handler finished. It surfaces as a store failure, and the lease decides any redelivery.
    await store.complete(job.id, hold.lease)
    return "completed"
  }

  async function runOne(job: StoredJob, hold: Hold): Promise<void> {
    const def = defs.get(job.name)
    if (def === undefined) {
      // A persisted job whose handler is gone (renamed/removed) can never run → dead-letter it.
      await store.deadLetter(
        job.id,
        `no handler defined for ${JSON.stringify(job.name)}`,
        hold.lease,
      )
      return
    }
    // Renewed at a third of the lease, so two renewals can fail before another worker may take it.
    const heartbeat =
      store.renew === undefined
        ? undefined
        : setInterval(
            () => {
              Promise.resolve()
                .then(() => store.renew?.(job.id, now() + leaseMs, hold.lease))
                .catch((error: unknown) => {
                  if (reportRenewal === undefined) {
                    console.error("[nifra/jobs] lease renewal failed:", error)
                  } else reportRenewal(error)
                })
            },
            Math.max(1, Math.floor(leaseMs / 3)),
          )
    try {
      await attemptWithHooks(job, hold, def)
    } finally {
      clearInterval(heartbeat)
    }
  }

  async function attemptWithHooks(job: StoredJob, hold: Hold, def: Def): Promise<void> {
    const attempt = job.attempt + 1
    const hook = instrument?.run
    if (hook === undefined) {
      await attemptJob(job, hold, def, attempt, undefined)
      return
    }
    let attempted: Promise<JobRunOutcome> | undefined
    let closed = false
    const next = (scope?: { readonly trace?: JobTraceContext }): Promise<JobRunOutcome> => {
      if (closed) return lateNext("run")
      attempted ??= handled(attemptJob(job, hold, def, attempt, scope?.trace))
      return attempted
    }
    const info = {
      id: job.id,
      name: job.name,
      attempt,
      maxAttempts: job.maxAttempts,
      traceparent: job.traceparent,
    }
    try {
      await hook.call(instrument, info, next)
    } catch {
      // The instrument cannot change the result; a store failure inside `next` surfaces below.
    }
    closed = true
    await (attempted ?? attemptJob(job, hold, def, attempt, undefined))
  }

  // One lease at a time, sized to the slots free when it starts, so callers sharing the slots
  // never over-lease. A slot is held until its own job settles, store failures included.
  function admit(): Promise<readonly Promise<void>[]> {
    if (leasing !== undefined) return leasing
    const free = concurrency - running.size
    if (free <= 0) return Promise.resolve([])
    const p = (async () => {
      const leased = await store.lease(now(), free, leaseMs)
      const started: Promise<void>[] = []
      for (const job of leased) {
        const holding = holds.get(job.id)
        if (holding !== undefined) {
          // The store handed back a job still running here, its lease run out: keep the one run, now
          // under the new lease, rather than start the handler a second time.
          holding.lease = job.lease
          continue
        }
        started.push(begin(job))
      }
      return started
    })().finally(() => {
      if (leasing === p) leasing = undefined
    })
    leasing = p
    return p
  }

  function begin(job: StoredJob): Promise<void> {
    const hold: Hold = { lease: job.lease }
    holds.set(job.id, hold)
    const run = runOne(job, hold)
    const release = (): void => {
      running.delete(run)
      if (holds.get(job.id) === hold) holds.delete(job.id)
    }
    running.add(run)
    run.then(release, release)
    return run
  }

  async function process(): Promise<number> {
    const started = await admit()
    const batch = started.length > 0 ? started : [...running]
    const settled = await Promise.allSettled(batch)
    for (const outcome of settled) if (outcome.status === "rejected") throw outcome.reason
    return batch.length
  }

  async function drain(): Promise<number> {
    let total = 0
    for (let n = await process(); n > 0; n = await process()) total += n
    return total
  }

  function start(opts: WorkerOptions = {}): Worker {
    assertWorkerOptions(opts)
    const lease = opts.leaseMs ?? 30_000
    for (const [name, def] of defs) assertTimeoutBelowLease(name, def.timeoutMs, lease)
    concurrency = opts.concurrency ?? 1
    leaseMs = lease
    const intervalMs = opts.pollIntervalMs ?? 250
    const onPollError =
      opts.onPollError ?? ((error: unknown) => console.error("[nifra/jobs] poll failed:", error))
    const report = (error: unknown): void => {
      try {
        onPollError(error)
      } catch {
        /* a throwing onPollError must not crash the worker */
      }
    }
    reportRenewal = report
    // Fills free slots without waiting on busy ones. A store outage must not become an unhandled
    // rejection, which ends a Node process.
    const poll = (): void => {
      admit().then((started) => {
        for (const run of started) run.catch(report)
      }, report)
    }
    if (timer === undefined) timer = setInterval(poll, intervalMs)
    return {
      get running() {
        return timer !== undefined
      },
      async stop() {
        if (timer !== undefined) {
          clearInterval(timer)
          timer = undefined
        }
        // Failures were already reported to onPollError.
        await leasing?.catch(() => {})
        await Promise.allSettled([...running])
      },
    }
  }

  return {
    define,
    enqueue: (name, payload, opts) => enqueue(name, payload, opts, undefined),
    process,
    drain,
    start,
    counts: () => store.counts(),
    store,
  }
}
