/**
 * The queue — typed `define`/`enqueue` over a {@link JobStore}, plus an in-process worker that leases due
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
 * of `start()` — `await q.process()` inside the `queue()` handler. See the README.
 */
import { exponentialBackoff } from "./backoff.ts"
import { MemoryJobStore } from "./memory-store.ts"
import type {
  Backoff,
  EnqueueOptions,
  JobCounts,
  JobDefinition,
  JobHandle,
  JobHandler,
  JobStore,
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
  // exactOptionalPropertyTypes — the value is genuinely "schema or none", not a maybe-present key.
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

/** Create a job queue. Define jobs, enqueue payloads, and `start()` a worker (or `drain()` once). */
export function createQueue(options: QueueOptions = {}): Queue {
  const store = options.store ?? new MemoryJobStore()
  const now = options.now ?? (() => Date.now())
  const onError =
    options.onError ??
    ((error, name) => console.error(`[nifra/jobs] job ${JSON.stringify(name)} failed:`, error))
  const defaultAttempts = options.defaultAttempts ?? 3
  const defaultBackoff = options.backoff ?? exponentialBackoff()
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
    return { name, enqueue: (payload, opts) => enqueue(name, payload, opts) }
  }

  async function enqueue(
    name: string,
    payload: unknown,
    opts: EnqueueOptions = {},
  ): Promise<string> {
    const def = defs.get(name)
    if (def === undefined)
      throw new JobError(`unknown job ${JSON.stringify(name)} — define it first`)
    const value = await validate(name, def.input, payload)
    const runAt = opts.runAt ?? now() + Math.max(0, opts.delayMs ?? 0)
    return await store.enqueue({ name, payload: value, runAt, maxAttempts: def.attempts })
  }

  async function runOne(job: StoredJob): Promise<void> {
    const def = defs.get(job.name)
    if (def === undefined) {
      // A persisted job whose handler is gone (renamed/removed) can never run → dead-letter it.
      await store.deadLetter(job.id, `no handler defined for ${JSON.stringify(job.name)}`)
      return
    }
    const attempt = job.attempt + 1
    try {
      await def.handler(job.payload, { id: job.id, name: job.name, attempt })
      await store.complete(job.id)
    } catch (err) {
      safeOnError(err, job.name)
      if (attempt >= job.maxAttempts) await store.deadLetter(job.id, errText(err))
      else await store.retry(job.id, now() + Math.max(0, def.backoff(attempt)))
    }
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
    concurrency = Math.max(1, opts.concurrency ?? 1)
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

  return { define, enqueue, process, drain, start, counts: () => store.counts(), store }
}
