import {
  defineRouterPlugin,
  type IdentityPlugin,
  jsonLogger,
  type Logger,
} from "@nifrajs/core/server"

type MaybePromise<T> = T | Promise<T>

/**
 * One readiness check: resolve `true` when the dependency can serve. A `false`, a throw and a
 * timeout all fail it. `signal` aborts at the check's timeout, so a ping can cancel its own I/O
 * instead of leaving a connection half-used.
 */
export type ReadinessCheck = (signal: AbortSignal) => MaybePromise<boolean>

export interface ReadinessCheckOptions {
  readonly check: ReadinessCheck
  /** Past it the check reports `timeout` and its `signal` aborts. Default: the healthcheck's. */
  readonly timeoutMs?: number
  /**
   * The app still serves without this dependency: failing reports `degraded` and leaves `/ready` at
   * `200`, so the instance stays in rotation.
   */
  readonly optional?: boolean
}

export type ReadinessCheckStatus = "pass" | "fail" | "timeout"

export interface ReadinessCheckResult {
  readonly status: ReadinessCheckStatus
  /** How long the check took, in whole ms. */
  readonly ms: number
  readonly optional?: true
}

export interface ReadinessReport {
  /**
   * `ok`: every check passed. `degraded`: only optional checks failed (`200`). `error`: a required
   * check failed (`503`). `stopping`: the server began stopping, and no check ran (`503`).
   */
  readonly status: "ok" | "degraded" | "error" | "stopping"
  readonly checks: Readonly<Record<string, ReadinessCheckResult>>
}

export interface HealthcheckOptions {
  /** Liveness path - always `200` while the process is up. Default `"/health"`. */
  readonly path?: string
  /** Readiness path - runs `checks`; see {@link ReadinessReport}. Default `"/ready"`. */
  readonly readyPath?: string
  /** Readiness checks (DB ping, cache reachable, …), each a function or its options. */
  readonly checks?: Readonly<Record<string, ReadinessCheck | ReadinessCheckOptions>>
  /** Timeout of a check that sets none, in ms. Default 2_000. */
  readonly timeoutMs?: number
  /**
   * How long a finished run answers later probes, in ms. Default 1_000; 0 runs the checks for every
   * probe. Probes that arrive while the checks run share that run either way, so neither a burst of
   * probes nor a client hammering a public `/ready` multiplies the pings.
   */
  readonly cacheMs?: number
  /**
   * Where a check moving between passing and failing is logged: a warning when it starts failing,
   * info when it passes again. Default `jsonLogger()`; `false` logs nothing.
   */
  readonly logger?: Logger | false
}

interface Entry {
  readonly name: string
  readonly check: ReadinessCheck
  readonly timeoutMs: number
  readonly optional: boolean
}

interface Outcome {
  readonly ok: boolean
  readonly error?: unknown
}

interface Measured {
  readonly entry: Entry
  readonly status: ReadinessCheckStatus
  readonly ms: number
  readonly error?: unknown
}

const noStore = { "cache-control": "no-store" } as const
const DEFAULT_TIMEOUT_MS = 2_000
const DEFAULT_CACHE_MS = 1_000
const STOPPING: ReadinessReport = { status: "stopping", checks: {} }

// Named per call, so a second, differently configured instance applies instead of being deduped.
let instances = 0

function timeoutOf(where: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`healthcheck: ${where} must be a finite number above 0`)
  }
  return value
}

function entriesOf(options: HealthcheckOptions, timeoutMs: number): Entry[] {
  return Object.entries(options.checks ?? {}).map(([name, spec]) =>
    typeof spec === "function"
      ? { name, check: spec, timeoutMs, optional: false }
      : {
          name,
          check: spec.check,
          timeoutMs: timeoutOf(`checks.${name}.timeoutMs`, spec.timeoutMs, timeoutMs),
          optional: spec.optional === true,
        },
  )
}

function reportOf(measured: readonly Measured[]): ReadinessReport {
  const checks: Record<string, ReadinessCheckResult> = {}
  let status: ReadinessReport["status"] = "ok"
  for (const { entry, status: result, ms } of measured) {
    checks[entry.name] = entry.optional
      ? { status: result, ms, optional: true }
      : { status: result, ms }
    if (result === "pass") continue
    if (!entry.optional) status = "error"
    else if (status === "ok") status = "degraded"
  }
  return { status, checks }
}

const answer = (report: ReadinessReport): Response =>
  Response.json(report, {
    status: report.status === "ok" || report.status === "degraded" ? 200 : 503,
    headers: noStore,
  })

/**
 * Register **liveness** (`/health`) and **readiness** (`/ready`) endpoints. Liveness is a flat `200`
 * (the process is serving). Readiness runs every check concurrently, each under its own timeout, and
 * answers a {@link ReadinessReport}: `200` while every required check passes, `503` otherwise. Both are
 * `Cache-Control: no-store`.
 *
 * Readiness answers `503 stopping` from the moment `stop()` begins - before the drain, so a load
 * balancer stops routing here while in-flight requests finish. Give it time to notice with
 * `stop({ delayMs })` (or `gracefulSignals: { delayMs }`).
 *
 * A check is never called again while an earlier call is still running: one that ignored its abort
 * signal is waited on rather than stacked, so a hung dependency costs one pending call, not one per
 * probe.
 *
 * Apply it **before** auth guards so the endpoints stay public (`beforeHandle` is order-scoped):
 *
 * ```ts
 * app.use(healthcheck({ checks: { db: (signal) => db.ping({ signal }) } })).use(bearer({ verify }))
 * ```
 */
export function healthcheck(options: HealthcheckOptions = {}): IdentityPlugin {
  const path = options.path ?? "/health"
  const readyPath = options.readyPath ?? "/ready"
  const entries = entriesOf(options, timeoutOf("timeoutMs", options.timeoutMs, DEFAULT_TIMEOUT_MS))
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS
  if (!Number.isFinite(cacheMs) || cacheMs < 0) {
    throw new RangeError("healthcheck: cacheMs must be a finite number, 0 or above")
  }
  const logger = options.logger === false ? undefined : (options.logger ?? jsonLogger())
  // A router plugin: the probes are registered as a side effect and the app comes back with its type
  // unchanged, so routes declared after `.use(healthcheck())` keep theirs. The probes are deliberately
  // absent from the caller's typed registry - they are operational endpoints, not part of the contract.
  return defineRouterPlugin(`healthcheck#${++instances}`, (app) => {
    // Per app: one instance handed to two servers must not report one's shutdown on the other.
    let stopping = false
    app.onStopping(() => {
      stopping = true
    })
    const pending = new Map<string, Promise<Outcome>>()
    const passing = new Map<string, boolean>()
    let running: Promise<ReadinessReport> | undefined
    let cached: ReadinessReport | undefined
    let cachedUntil = 0

    const measure = async (entry: Entry): Promise<Measured> => {
      const started = performance.now()
      let call = pending.get(entry.name)
      let controller: AbortController | undefined
      if (call === undefined) {
        const own = new AbortController()
        controller = own
        const fresh = Promise.resolve()
          .then(() => entry.check(own.signal))
          .then(
            (value): Outcome => ({ ok: value === true }),
            (error: unknown): Outcome => ({ ok: false, error }),
          )
        pending.set(entry.name, fresh)
        void fresh.then(() => pending.delete(entry.name))
        call = fresh
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const outcome = await Promise.race([
        call,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), entry.timeoutMs)
        }),
      ])
      clearTimeout(timer)
      const ms = Math.round(performance.now() - started)
      if (outcome === undefined) {
        controller?.abort(new DOMException("readiness check timed out", "TimeoutError"))
        return { entry, status: "timeout", ms }
      }
      return { entry, status: outcome.ok ? "pass" : "fail", ms, error: outcome.error }
    }

    const log = (measured: readonly Measured[]): void => {
      for (const { entry, status, ms, error } of measured) {
        const passes = status === "pass"
        // A check is presumed passing before its first run, so starting unready is logged too.
        const before = passing.get(entry.name) ?? true
        passing.set(entry.name, passes)
        if (logger === undefined || before === passes) continue
        if (passes) logger.info("readiness check passing", { check: entry.name, ms })
        else
          logger.warn("readiness check failing", {
            check: entry.name,
            status,
            ms,
            optional: entry.optional,
            error: error instanceof Error ? error.message : undefined,
          })
      }
    }

    const run = async (): Promise<ReadinessReport> => {
      const measured = await Promise.all(entries.map(measure))
      log(measured)
      const report = reportOf(measured)
      cached = report
      cachedUntil = Date.now() + cacheMs
      return report
    }

    app.register("GET", path, undefined, () =>
      Response.json({ status: "ok" }, { headers: noStore }),
    )
    app.register("GET", readyPath, undefined, async () => {
      if (stopping) return answer(STOPPING)
      if (cached !== undefined && Date.now() < cachedUntil) return answer(cached)
      running ??= run().finally(() => {
        running = undefined
      })
      const report = await running
      // A stop that began while the checks ran wins over what they found.
      return answer(stopping ? STOPPING : report)
    })
    return app
  })
}
