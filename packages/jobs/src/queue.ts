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

export interface QueueOptions {
  /** Persistence. Default: a fresh {@link MemoryJobStore} (single-process). */
  readonly store?: JobStore
  /** Called when a handler throws (before retry/dead-letter). Default: `console.error`. A throwing handler here is swallowed. */
  readonly onError?: (error: unknown, jobName: string) => void
  /** Injectable clock (tests). Default `() => Date.now()`. */
  readonly now?: () => number
  /** Default attempts for jobs that don't set `retries`. Default 3. */
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
  /** Max jobs in flight at once. Default 1. */
  readonly concurrency?: number
  /** How often to poll the store for due jobs (ms). Default 250. */
  readonly pollIntervalMs?: number
  /** How long a leased job is hidden before it's considered abandoned and re-leased (ms). Default 30_000. */
  readonly leaseMs?: number
}

export interface Worker {
  /** Stop polling and await the in-flight round (graceful). */
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
  /** Run ONE poll round: lease up to `concurrency` due jobs, run them, await them. Returns the count run.
   * Re-entrant-safe (a concurrent call returns the in-flight round). Used by `start()` and by Workers. */
  process(): Promise<number>
  /** Process repeatedly until no job is due (one-shot batch drain). */
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
}

function normalizeRetries(
  retries: number | RetryPolicy | undefined,
  defaultAttempts: number,
  defaultBackoff: Backoff,
): { attempts: number; backoff: Backoff } {
  if (retries === undefined) return { attempts: defaultAttempts, backoff: defaultBackoff }
  if (typeof retries === "number")
    return { attempts: Math.max(1, retries), backoff: defaultBackoff }
  return { attempts: Math.max(1, retries.attempts), backoff: retries.backoff ?? defaultBackoff }
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const TRACEPARENT = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/

// A shape check only, to keep arbitrary strings out of the store; the tracer parses it properly.
const traceparentOrUndefined = (value: unknown): string | undefined =>
  typeof value === "string" && value.length === 55 && TRACEPARENT.test(value) ? value : undefined

function contextTraceparent(context: object): string | undefined {
  const trace = (context as { readonly trace?: unknown }).trace
  return typeof trace === "object" && trace !== null
    ? traceparentOrUndefined((trace as { readonly traceparent?: unknown }).traceparent)
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

/** Create a job queue. Define jobs, enqueue payloads, and `start()` a worker (or `drain()` once). */
export function createQueue(options: QueueOptions = {}): Queue {
  const store = options.store ?? new MemoryJobStore()
  const now = options.now ?? (() => Date.now())
  const onError =
    options.onError ??
    ((error, name) => console.error(`[nifra/jobs] job ${JSON.stringify(name)} failed:`, error))
  const defaultAttempts = options.defaultAttempts ?? 3
  const defaultBackoff = options.backoff ?? exponentialBackoff()
  const enqueueToken = options.capabilities?.enqueue ?? "jobs.enqueue"
  const instrument = options.instrument
  const defs = new Map<string, Def>()

  let timer: ReturnType<typeof setInterval> | undefined
  let concurrency = 1
  let leaseMs = 30_000
  let round: Promise<number> | undefined

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
    const runAt = opts.runAt ?? now() + Math.max(0, opts.delayMs ?? 0)
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
    def: Def,
    attempt: number,
    trace: JobTraceContext | undefined,
  ): Promise<JobRunOutcome> {
    try {
      await def.handler(
        job.payload,
        trace === undefined
          ? { id: job.id, name: job.name, attempt }
          : { id: job.id, name: job.name, attempt, trace },
      )
      await store.complete(job.id)
      return "completed"
    } catch (err) {
      safeOnError(err, job.name)
      if (attempt >= job.maxAttempts) {
        await store.deadLetter(job.id, errText(err))
        return "dead-lettered"
      }
      await store.retry(job.id, now() + Math.max(0, def.backoff(attempt)))
      return "retried"
    }
  }

  async function runOne(job: StoredJob): Promise<void> {
    const def = defs.get(job.name)
    if (def === undefined) {
      // A persisted job whose handler is gone (renamed/removed) can never run → dead-letter it.
      await store.deadLetter(job.id, `no handler defined for ${JSON.stringify(job.name)}`)
      return
    }
    const attempt = job.attempt + 1
    const hook = instrument?.run
    if (hook === undefined) {
      await attemptJob(job, def, attempt, undefined)
      return
    }
    let attempted: Promise<JobRunOutcome> | undefined
    let closed = false
    const next = (scope?: { readonly trace?: JobTraceContext }): Promise<JobRunOutcome> => {
      if (closed) return lateNext("run")
      attempted ??= handled(attemptJob(job, def, attempt, scope?.trace))
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
    await (attempted ?? attemptJob(job, def, attempt, undefined))
  }

  async function processInner(): Promise<number> {
    const leased = await store.lease(now(), concurrency, leaseMs)
    if (leased.length === 0) return 0
    await Promise.all(leased.map(runOne))
    return leased.length
  }

  function process(): Promise<number> {
    if (round !== undefined) return round // one round at a time
    const p = processInner().finally(() => {
      if (round === p) round = undefined
    })
    round = p
    return p
  }

  async function drain(): Promise<number> {
    let total = 0
    for (let n = await processInner(); n > 0; n = await processInner()) total += n
    return total
  }

  function start(opts: WorkerOptions = {}): Worker {
    assertWorkerOptions(opts)
    concurrency = opts.concurrency ?? 1
    leaseMs = opts.leaseMs ?? 30_000
    const intervalMs = opts.pollIntervalMs ?? 250
    if (timer === undefined) timer = setInterval(() => void process(), intervalMs)
    return {
      get running() {
        return timer !== undefined
      },
      async stop() {
        if (timer !== undefined) {
          clearInterval(timer)
          timer = undefined
        }
        if (round !== undefined) await round
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
