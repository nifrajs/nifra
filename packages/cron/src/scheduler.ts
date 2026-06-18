/**
 * The scheduler — a thin, testable timer over the pure {@link parseCron}/{@link matches} core.
 * Runtime-agnostic (`setInterval`/`Date`, available on Bun/Node/Deno). For LONG-RUNNING servers;
 * Cloudflare Workers has no long-lived process, so use the platform `scheduled` trigger there
 * (`toFetchHandler(app, { scheduled })`) instead.
 *
 * Guarantees: a job that throws never tears down the loop (routed to `onError`); a job still running
 * when its next minute arrives is **skipped, not stacked** (no overlap); `stop()` is graceful.
 */

import { type CronFields, matches, parseCron } from "./parse.ts"

export type CronHandler = () => void | Promise<void>

interface Job {
  readonly name: string
  readonly expr: string
  readonly fields: CronFields
  readonly handler: CronHandler
  running: boolean
  /** `YYYY-M-D-H-M` of the last minute this job fired — so one tick-per-minute fires it once. */
  lastFiredMinute: string
}

export interface SchedulerOptions {
  /** Called when a job handler throws/rejects. Default: `console.error`. A throwing onError is swallowed. */
  readonly onError?: (error: unknown, jobName: string) => void
  /** Injectable clock (tests). Default `() => new Date()`. */
  readonly now?: () => Date
}

export interface Scheduler {
  /** Register a job. Throws `CronError` now (not at fire time) on a bad expression or duplicate name. */
  add(name: string, expression: string, handler: CronHandler): Scheduler
  /** Begin checking on an interval (default 15s — well under a minute, so no minute is missed). */
  start(checkIntervalMs?: number): void
  /** Stop checking. In-flight handlers are left to finish (graceful). */
  stop(): void
  /** Run every job DUE at `now` that hasn't fired this minute. Exposed for tests + custom drivers. */
  tick(now?: Date): void
  /** Fire a job immediately by name, off-schedule (e.g. a manual admin trigger). No-op if unknown. */
  runNow(name: string): void
  /** Registered job names, in insertion order. */
  readonly jobNames: readonly string[]
}

const minuteKey = (d: Date): string =>
  `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`

/** Create an in-process cron scheduler. */
export function createScheduler(options: SchedulerOptions = {}): Scheduler {
  const now = options.now ?? (() => new Date())
  const onError =
    options.onError ??
    ((error, jobName) =>
      console.error(`[nifra/cron] job ${JSON.stringify(jobName)} failed:`, error))
  const jobs = new Map<string, Job>()
  let timer: ReturnType<typeof setInterval> | undefined

  const fire = (job: Job): void => {
    if (job.running) return // overlap guard: previous run still in flight → skip this minute
    job.running = true
    let result: void | Promise<void>
    try {
      result = job.handler()
    } catch (err) {
      job.running = false
      onErrorSafe(err, job.name)
      return
    }
    if (result instanceof Promise) {
      result.then(
        () => {
          job.running = false
        },
        (err) => {
          job.running = false
          onErrorSafe(err, job.name)
        },
      )
    } else {
      job.running = false
    }
  }

  const onErrorSafe = (err: unknown, name: string): void => {
    try {
      onError(err, name)
    } catch {
      /* a throwing error handler must not crash the scheduler loop */
    }
  }

  const scheduler: Scheduler = {
    add(name, expression, handler) {
      if (jobs.has(name)) {
        throw new Error(`[nifra/cron] a job named ${JSON.stringify(name)} is already registered`)
      }
      jobs.set(name, {
        name,
        expr: expression,
        fields: parseCron(expression), // throws CronError now on a bad expression
        handler,
        running: false,
        lastFiredMinute: "",
      })
      return scheduler
    },
    tick(at = now()) {
      const key = minuteKey(at)
      for (const job of jobs.values()) {
        if (job.lastFiredMinute === key) continue // already fired this minute
        if (matches(job.fields, at)) {
          job.lastFiredMinute = key
          fire(job)
        }
      }
    },
    start(checkIntervalMs = 15_000) {
      if (timer !== undefined) return // already started
      timer = setInterval(() => scheduler.tick(), checkIntervalMs)
      // Don't keep the process alive solely for the scheduler (Node/Bun `unref`); harmless if absent.
      ;(timer as { unref?: () => void }).unref?.()
    },
    stop() {
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
    },
    runNow(name) {
      const job = jobs.get(name)
      if (job !== undefined) fire(job)
    },
    get jobNames() {
      return [...jobs.keys()]
    },
  }
  return scheduler
}
