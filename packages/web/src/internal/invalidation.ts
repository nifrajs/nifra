/**
 * One invalidation pipeline for everything a write makes stale, in a fixed order: data caches (tags),
 * then the page store (paths and tags), then the live publish (keys and tags), then the CDN. A failure
 * in either cache stage stops before the publish: clients told to reload would read the stale data and
 * move their watermarks past the change. Every stage is idempotent, so a retry repeats from the stage
 * that failed.
 *
 * `withISR` owns the pipeline when it wraps the app; without it, `createWebApp` runs the publish
 * stage alone. Never both.
 */
import type { CacheStore, CdnPurgeTarget, ISRPlatform } from "../isr.ts"
import type { InvalidationOp } from "./invalidation-contract.ts"

export type { InvalidationOp } from "./invalidation-contract.ts"

export type InvalidationStage = "data" | "pages" | "publish" | "cdn"

export interface StageReport {
  readonly stage: InvalidationStage
  readonly ok: boolean
  readonly retryable: boolean
  readonly error?: string
  /** The CDN took the purge but has not applied it yet (rate limit or retry). */
  readonly queued?: true
}

export interface InvalidationReport {
  readonly id: string
  readonly ok: boolean
  readonly stages: readonly StageReport[]
}

/** What the pipeline calls on a page store: any {@link CacheStore} fits. */
export interface PagePurge {
  delete(key: string): Promise<void>
  readonly invalidateTag?: ((tag: string) => Promise<void>) | undefined
}

export interface InvalidationTargets {
  readonly dataCaches?: readonly { invalidateTag(tag: string): unknown }[] | undefined
  readonly store?: PagePurge | undefined
  /** The page store key of a path, as the cache wrapper computes it; `null` when never stored. */
  readonly keyOf?: ((path: string, req: Request) => string | null) | undefined
  readonly publish?: ((keys: readonly string[]) => Promise<void>) | undefined
  readonly cdn?: CdnPurgeTarget | undefined
}

const ORDER: readonly InvalidationStage[] = ["data", "pages", "publish", "cdn"]
/** Retry delays after a retryable failure; inline retries stop at {@link INLINE_DEADLINE_MS}. */
const RETRY_MS = [200, 600, 1800]
export const INLINE_DEADLINE_MS = 2000

/** Run the stages from `from` once. */
export async function runInvalidation(
  op: InvalidationOp,
  targets: InvalidationTargets,
  req: Request,
  platform: ISRPlatform | undefined,
  from: InvalidationStage = "data",
): Promise<InvalidationReport> {
  const stages: StageReport[] = []
  for (const stage of ORDER.slice(ORDER.indexOf(from))) {
    // Decided before any await: a stage with nothing to do costs no turn of the event loop.
    const running = startStage(stage, op, targets, req, platform)
    if (running === undefined) continue
    const report = await running
    stages.push(report)
    // A cache stage that failed leaves data a reload would read: nothing after it may run.
    if (!report.ok && (stage === "data" || stage === "pages")) break
  }
  return { id: op.id, ok: stages.every((report) => report.ok), stages }
}

/** Start a stage's work for this operation; `undefined` when it has none. Never rejects. */
function startStage(
  stage: InvalidationStage,
  op: InvalidationOp,
  targets: InvalidationTargets,
  req: Request,
  platform: ISRPlatform | undefined,
): Promise<StageReport> | undefined {
  const done: StageReport = { stage, ok: true, retryable: false }
  let work: Promise<StageReport>
  switch (stage) {
    case "data": {
      const caches = targets.dataCaches
      if (op.tags.length === 0 || caches === undefined) return undefined
      work = (async () => {
        for (const cache of caches) {
          for (const tag of op.tags) await cache.invalidateTag(tag)
        }
        return done
      })()
      break
    }
    case "pages": {
      const store = targets.store
      if (store === undefined || op.paths.length + op.tags.length === 0) return undefined
      work = (async (): Promise<StageReport> => {
        if (op.tags.length > 0 && store.invalidateTag === undefined) {
          return { stage, ok: false, retryable: false, error: "tag_invalidation_not_supported" }
        }
        for (const path of op.paths) {
          const key = targets.keyOf?.(path, req) ?? null
          if (key !== null) await store.delete(key)
        }
        for (const tag of op.tags) await store.invalidateTag?.(tag)
        return done
      })()
      break
    }
    case "publish": {
      const publish = targets.publish
      if (publish === undefined || op.keys.length + op.tags.length === 0) return undefined
      work = (async () => {
        await publish([...new Set([...op.keys, ...op.tags])])
        return done
      })()
      break
    }
    case "cdn": {
      const cdn = targets.cdn
      if (cdn === undefined || op.paths.length + op.tags.length === 0) return undefined
      work = (async (): Promise<StageReport> => {
        const outcome = await cdn.purge({ tags: op.tags, paths: op.paths }, platform)
        return outcome.cdn === "failed"
          ? {
              stage,
              ok: false,
              retryable: outcome.retryable,
              error: outcome.error ?? "cdn_purge_failed",
            }
          : outcome.cdn === "queued"
            ? { stage, ok: true, retryable: false, queued: true }
            : done
      })()
      break
    }
  }
  return work.catch(() => ({ stage, ok: false, retryable: true, error: `${stage}_failed` }))
}

export interface SettleOptions {
  readonly onError?: ((report: InvalidationReport) => void) | undefined
  /** Tests drive time; production waits on timers. */
  readonly clock?: { now(): number; sleep(ms: number): Promise<void> }
}

const realClock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}

/**
 * Run the pipeline for a write; never throws and never changes the response. A retryable failure
 * retries from the failed stage, under `waitUntil` when the platform has it, else inline until
 * {@link INLINE_DEADLINE_MS}. A failure that remains is reported once.
 */
export async function settleInvalidation(
  op: InvalidationOp,
  targets: InvalidationTargets,
  req: Request,
  platform: ISRPlatform | undefined,
  options: SettleOptions = {},
): Promise<InvalidationReport> {
  const onError = options.onError ?? logInvalidation
  const clock = options.clock ?? realClock
  const started = clock.now()
  const first = await runInvalidation(op, targets, req, platform)
  if (first.ok) return first
  const failed = first.stages.find((report) => !report.ok)
  if (failed === undefined || !failed.retryable) {
    report(onError, first)
    return first
  }
  const background = typeof platform?.waitUntil === "function"
  const retry = async (): Promise<InvalidationReport> => {
    let last = first
    let stage = failed.stage
    for (const delay of RETRY_MS) {
      if (!background && clock.now() - started + delay >= INLINE_DEADLINE_MS) break
      await clock.sleep(delay)
      last = await runInvalidation(op, targets, req, platform, stage)
      const next = last.stages.find((report) => !report.ok)
      if (next === undefined) return last
      if (!next.retryable) break
      stage = next.stage
    }
    report(onError, last)
    return last
  }
  if (background) {
    platform?.waitUntil?.(retry())
    return first
  }
  return retry()
}

function report(onError: (report: InvalidationReport) => void, value: InvalidationReport): void {
  try {
    onError(value)
  } catch {
    // A failing reporter must not reach the response.
  }
}

/** The default report: the operation id and the stage, never a path, tag or key. */
export function logInvalidation(report: InvalidationReport): void {
  const failed = report.stages.find((stage) => !stage.ok)
  console.error(
    `[nifra/web] invalidation ${report.id} gave up at the ${failed?.stage ?? "unknown"} stage (${failed?.error ?? "failed"})`,
  )
}
