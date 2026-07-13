import type { AdmissionController, AdmissionDecision } from "@nifrajs/core"

/**
 * Adaptive capacity admission. Rate limiting bounds request *frequency* and `@nifrajs/budget` bounds
 * request *duration*; neither stops a healthy instance from accepting more *concurrent* work than it
 * can finish. This gate admits on live capacity evidence — in-flight count + event-loop lag — briefly
 * queues at the edge, and sheds the rest with `429` + `Retry-After`, so p99 stays bounded under load
 * instead of collapsing.
 *
 * Public mechanics (in-flight + loop lag) know nothing about tenants. A private {@link AdmissionPolicy}
 * hook — provided by `@platform` — layers tenant priority and reserved capacity on top without leaking
 * those concerns into the OSS core.
 *
 * Wire it as the server's `admission` option (NOT an `onRequest` hook — a hook disables the native
 * route table). Off by default: when unset, the request path is untouched.
 */

export type ShedReason = "inflight" | "loop-lag" | "queue-timeout" | "policy" | "cancelled"

/** Pure capacity evidence handed to the private policy. The mechanics never invent tenant concepts. */
export interface AdmissionEvidence {
  readonly inFlight: number
  readonly maxInFlight: number
  readonly lagMs: number
  readonly maxLagMs: number
  readonly queued: number
}

/**
 * Private admission policy (lives in `@platform`). Return a decision to override the default mechanics
 * for this request, or `undefined` to defer to them. `admit` may draw from reserved headroom above
 * `maxInFlight`; `shed` forces rejection.
 */
export type AdmissionPolicy = (
  req: Request,
  evidence: AdmissionEvidence,
) => { decision: "admit" | "shed"; retryAfterSec?: number } | undefined

export interface AdmissionOptions {
  /** Max requests running concurrently before the gate queues or sheds. */
  readonly maxInFlight: number
  /** Event-loop lag ceiling (ms); above it, shed even when slots are free (protects p99). Default ∞. */
  readonly maxLagMs?: number
  /** How many requests may briefly wait for a slot before shedding. `0` (default) never queues. */
  readonly maxQueue?: number
  /** How long a queued request waits for a slot before shedding. Default 50ms. */
  readonly queueTimeoutMs?: number
  /** Reserved slots ABOVE `maxInFlight` that only a policy `admit` may draw from. Default 0. */
  readonly reservedForPolicy?: number
  /** Base `Retry-After`, in seconds, for shed responses. Default 1. */
  readonly baseRetryAfterSec?: number
  /**
   * Live event-loop lag source, in ms. Pass {@link createEventLoopLagSampler} to sample the real loop;
   * default `() => 0` disables lag-based shedding (in-flight only).
   */
  readonly lagMs?: () => number
  readonly policy?: AdmissionPolicy
  /** Test seam for deterministic queue timeouts; defaults to real timers. */
  readonly setTimer?: (fn: () => void, ms: number) => { cancel(): void }
}

export interface AdmissionSnapshot {
  readonly inFlight: number
  readonly queued: number
  readonly fastPathAdmits: number
  readonly slowPathEntries: number
  readonly everQueued: number
  readonly shed: number
}

export interface AdmissionControllerHandle extends AdmissionController {
  /** Point-in-time counters for observability (otel gauges/counters). */
  snapshot(): AdmissionSnapshot
}

interface Waiter {
  settled: boolean
  transfer(): void
  shed(): void
  cancel(): void
  cleanup(): void
  timer: { cancel(): void }
}

const OVERLOADED_BODY = JSON.stringify({ ok: false, error: "overloaded" })

/** The slice of a `perf_hooks` event-loop-delay histogram the sampler needs. */
export interface LoopDelayHistogram {
  enable(): void
  reset(): void
  readonly mean: number
}

/**
 * Acquires a loop-delay histogram for a resolution, or `undefined` when the runtime has none. This is
 * an optional test/runtime seam; the default sampler is a portable timer-drift monitor.
 */
export type LoopDelayMonitor = (resolutionMs: number) => LoopDelayHistogram | undefined

/** Shared no-op sampler — the fallback when an explicitly supplied monitor has no histogram. */
const NO_LAG: () => number = () => 0

/**
 * Event-loop-lag sampler. By default it measures timer drift using only Web/JS runtime primitives, so
 * it works under Node ESM, Bun, Deno, and workers without a hidden CommonJS `require` fallback. An
 * injected histogram remains available for deterministic tests or a runtime-native monitor. Each read
 * returns recent mean lag and resets the sampling window.
 */
export function createEventLoopLagSampler(
  resolutionMs = 20,
  monitor?: LoopDelayMonitor,
): () => number {
  if (!Number.isFinite(resolutionMs) || resolutionMs <= 0) {
    throw new RangeError("admission: resolutionMs must be a finite positive number")
  }
  if (monitor === undefined) {
    let expected = performance.now() + resolutionMs
    let totalLagMs = 0
    let samples = 0
    const timer = setInterval(() => {
      const now = performance.now()
      totalLagMs += Math.max(0, now - expected)
      samples++
      // Reset from `now` so one long stall is measured once instead of as a train of catch-up ticks.
      expected = now + resolutionMs
    }, resolutionMs)
    // A metrics sampler must never keep a Node/Bun process alive by itself. Browser/Deno numeric timer
    // handles simply do not expose `unref`.
    ;(timer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.()
    return () => {
      const mean = samples === 0 ? 0 : totalLagMs / samples
      totalLagMs = 0
      samples = 0
      return Number.isFinite(mean) ? mean : 0
    }
  }
  let histogram: LoopDelayHistogram | undefined
  try {
    histogram = monitor(resolutionMs)
  } catch {
    return NO_LAG
  }
  if (histogram === undefined) return NO_LAG
  histogram.enable()
  return () => {
    const meanNs = histogram.mean
    histogram.reset()
    return Number.isFinite(meanNs) ? Math.max(0, meanNs / 1e6 - resolutionMs) : 0
  }
}

/**
 * Build a capacity-admission controller. Pass the returned handle as the server's `admission` option.
 */
export function createAdmissionController(options: AdmissionOptions): AdmissionControllerHandle {
  const maxInFlight = options.maxInFlight
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1) {
    throw new Error("admission: maxInFlight must be a positive integer")
  }
  const maxLagMs = options.maxLagMs ?? Number.POSITIVE_INFINITY
  if (Number.isNaN(maxLagMs) || maxLagMs < 0) {
    throw new Error("admission: maxLagMs must be a non-negative number")
  }
  const maxQueue = options.maxQueue ?? 0
  if (!Number.isInteger(maxQueue) || maxQueue < 0) {
    throw new Error("admission: maxQueue must be a non-negative integer")
  }
  const queueTimeoutMs = options.queueTimeoutMs ?? 50
  const reserved = options.reservedForPolicy ?? 0
  const baseRetryAfterSec = options.baseRetryAfterSec ?? 1
  if (!Number.isFinite(queueTimeoutMs) || queueTimeoutMs < 0) {
    throw new Error("admission: queueTimeoutMs must be a finite non-negative number")
  }
  if (!Number.isInteger(reserved) || reserved < 0) {
    throw new Error("admission: reservedForPolicy must be a non-negative integer")
  }
  if (!Number.isFinite(baseRetryAfterSec) || baseRetryAfterSec <= 0) {
    throw new Error("admission: baseRetryAfterSec must be a finite positive number")
  }
  const lagMs = options.lagMs ?? (() => 0)
  const policy = options.policy
  const setTimer =
    options.setTimer ??
    ((fn, ms) => {
      const id = setTimeout(fn, ms)
      return { cancel: () => clearTimeout(id) }
    })

  let inFlight = 0
  const queue: Waiter[] = []
  const stats = { fastPathAdmits: 0, slowPathEntries: 0, everQueued: 0, shed: 0 }

  const shedResponse = (
    reason: ShedReason,
    retryAfterSec = baseRetryAfterSec,
  ): AdmissionDecision => {
    const retry =
      Number.isFinite(retryAfterSec) && retryAfterSec >= 0 ? retryAfterSec : baseRetryAfterSec
    stats.shed++
    return {
      admitted: false,
      response: new Response(OVERLOADED_BODY, {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": String(Math.max(1, Math.ceil(retry))),
          "x-nifra-shed-reason": reason,
        },
      }),
    }
  }

  const cancelledResponse = (): AdmissionDecision => ({
    admitted: false,
    response: new Response(JSON.stringify({ ok: false, error: "request_cancelled" }), {
      status: 499,
      headers: {
        "content-type": "application/json",
        "x-nifra-shed-reason": "cancelled",
      },
    }),
  })

  // A release handle over an already-occupied slot. Decrement first, then transfer only when total
  // occupancy is below the public limit. This matters when policy traffic occupies reserved headroom:
  // releasing a reserved slot must NOT hand that capacity to an ordinary queued request.
  const makeHandle = (): AdmissionDecision => {
    let released = false
    return {
      admitted: true,
      release() {
        if (released) return
        released = true
        inFlight--
        while (inFlight < maxInFlight && queue.length > 0) {
          const next = queue.shift() as Waiter
          if (next.settled) continue
          next.settled = true
          next.cleanup()
          inFlight++
          next.transfer()
          return
        }
      },
    }
  }

  /** Take a brand-new slot (fast path, policy admit, reserved headroom). */
  const occupy = (): AdmissionDecision => {
    inFlight++
    return makeHandle()
  }

  function admit(req: Request): AdmissionDecision | Promise<AdmissionDecision> {
    const measuredLag = lagMs()
    // Invalid capacity evidence must not silently turn protection off.
    const lag =
      Number.isFinite(measuredLag) && measuredLag >= 0 ? measuredLag : Number.POSITIVE_INFINITY
    const evidence: AdmissionEvidence = {
      inFlight,
      maxInFlight,
      lagMs: lag,
      maxLagMs,
      queued: queue.length,
    }

    // Private policy first: may force-admit (reserved headroom) or force-shed.
    if (policy !== undefined) {
      const verdict = policy(req, evidence)
      if (verdict?.decision === "shed")
        return shedResponse("policy", verdict.retryAfterSec ?? baseRetryAfterSec)
      if (verdict?.decision === "admit") {
        return inFlight < maxInFlight + reserved ? occupy() : shedResponse("policy")
      }
    }

    // Loop-lag shed: the box is behind on the event loop — reject regardless of slot count.
    if (lag > maxLagMs) return shedResponse("loop-lag")

    // FAST PATH (O(1)): a slot is free and lag is fine. No timer, no queue, no extra await.
    if (inFlight < maxInFlight) {
      stats.fastPathAdmits++
      return occupy()
    }

    // SLOW PATH: saturated. Briefly queue, else shed.
    stats.slowPathEntries++
    if (maxQueue <= 0 || queue.length >= maxQueue) return shedResponse("inflight")
    stats.everQueued++
    return new Promise<AdmissionDecision>((resolve) => {
      const remove = (waiter: Waiter): void => {
        const i = queue.indexOf(waiter)
        if (i >= 0) queue.splice(i, 1)
      }
      const waiter: Waiter = {
        settled: false,
        transfer: () => resolve(makeHandle()),
        shed: () => resolve(shedResponse("queue-timeout")),
        cancel: () => resolve(cancelledResponse()),
        cleanup: () => {
          waiter.timer.cancel()
          req.signal.removeEventListener("abort", onAbort)
        },
        timer: setTimer(() => {
          if (waiter.settled) return
          waiter.settled = true
          remove(waiter)
          waiter.cleanup()
          waiter.shed()
        }, queueTimeoutMs),
      }
      const onAbort = (): void => {
        if (waiter.settled) return
        waiter.settled = true
        remove(waiter)
        waiter.cleanup()
        waiter.cancel()
      }
      queue.push(waiter)
      req.signal.addEventListener("abort", onAbort, { once: true })
      if (req.signal.aborted) onAbort()
    })
  }

  return {
    admit,
    snapshot: () => ({ inFlight, queued: queue.length, ...stats }),
  }
}
