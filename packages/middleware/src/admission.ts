import type { AdmissionController, AdmissionDecision } from "@nifrajs/core"

/**
 * Adaptive capacity admission. Rate limiting bounds request *frequency* and `@nifrajs/budget` bounds
 * request *duration*; neither stops a healthy instance from accepting more *concurrent* work than it
 * can finish. This gate admits on live capacity evidence — in-flight count + event-loop lag — briefly
 * queues at the edge, and sheds the rest with `429` + `Retry-After`, so p99 stays bounded under load
 * instead of collapsing.
 *
 * Public mechanics (in-flight + loop lag) know nothing about tenants. An application-supplied {@link AdmissionPolicy}
 * hook layers tenant priority and reserved capacity on top without leaking
 * those concerns into the OSS core.
 *
 * Wire it as the server's `admission` option (NOT an `onRequest` hook — a hook disables the native
 * route table). Off by default: when unset, the request path is untouched.
 */

export type ShedReason = "inflight" | "loop-lag" | "queue-timeout" | "policy"

/** Pure capacity evidence handed to the policy hook. The mechanics never invent tenant concepts. */
export interface AdmissionEvidence {
  readonly inFlight: number
  readonly maxInFlight: number
  readonly lagMs: number
  readonly maxLagMs: number
  readonly queued: number
}

/**
 * Application-supplied admission policy. Return a decision to override the default mechanics
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
 * Acquires a loop-delay histogram for a resolution, or `undefined` when the runtime has none. Inject
 * one in {@link createEventLoopLagSampler} for non-Node runtimes or tests; the default reads
 * `node:perf_hooks`.
 */
export type LoopDelayMonitor = (resolutionMs: number) => LoopDelayHistogram | undefined

/** Shared no-op sampler — the fallback when no histogram is available. */
const NO_LAG: () => number = () => 0

function defaultLoopDelayMonitor(resolutionMs: number): LoopDelayHistogram | undefined {
  // Lazy require so bundles for runtimes without perf_hooks (workers) don't pull it in.
  const perfHooks = require("node:perf_hooks") as typeof import("node:perf_hooks")
  return perfHooks.monitorEventLoopDelay?.({ resolution: resolutionMs })
}

/**
 * A default event-loop-lag sampler backed by `perf_hooks.monitorEventLoopDelay`. Returns the mean lag
 * (ms) observed since the previous call, resetting each read so shedding reacts to *recent* stalls, not
 * cumulative history. Falls back to a constant `0` when the runtime exposes no histogram (or `monitor`
 * throws) — pass a custom {@link LoopDelayMonitor} for non-Node runtimes.
 */
export function createEventLoopLagSampler(
  resolutionMs = 20,
  monitor: LoopDelayMonitor = defaultLoopDelayMonitor,
): () => number {
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
  const maxQueue = options.maxQueue ?? 0
  if (!Number.isInteger(maxQueue) || maxQueue < 0) {
    throw new Error("admission: maxQueue must be a non-negative integer")
  }
  const queueTimeoutMs = options.queueTimeoutMs ?? 50
  const reserved = options.reservedForPolicy ?? 0
  const baseRetryAfterSec = options.baseRetryAfterSec ?? 1
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

  const shedResponse = (reason: ShedReason, extra = 0): AdmissionDecision => {
    stats.shed++
    return {
      admitted: false,
      response: new Response(OVERLOADED_BODY, {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": String(Math.max(1, baseRetryAfterSec + extra)),
          "x-nifra-shed-reason": reason,
        },
      }),
    }
  }

  // A release handle over an already-occupied slot. On release it transfers the slot to the head
  // waiter (conserving inFlight) or frees it. Does NOT increment — a transfer must not double-count.
  const makeHandle = (): AdmissionDecision => {
    let released = false
    return {
      admitted: true,
      release() {
        if (released) return
        released = true
        while (queue.length > 0) {
          const next = queue.shift() as Waiter
          if (next.settled) continue
          next.settled = true
          next.timer.cancel()
          next.transfer()
          return
        }
        inFlight--
      },
    }
  }

  /** Take a brand-new slot (fast path, policy admit, reserved headroom). */
  const occupy = (): AdmissionDecision => {
    inFlight++
    return makeHandle()
  }

  function admit(req: Request): AdmissionDecision | Promise<AdmissionDecision> {
    const lag = lagMs()
    const evidence: AdmissionEvidence = {
      inFlight,
      maxInFlight,
      lagMs: lag,
      maxLagMs,
      queued: queue.length,
    }

    // Policy hook first: may force-admit (reserved headroom) or force-shed.
    if (policy !== undefined) {
      const verdict = policy(req, evidence)
      if (verdict?.decision === "shed") return shedResponse("policy", verdict.retryAfterSec ?? 0)
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
      const waiter: Waiter = {
        settled: false,
        transfer: () => resolve(makeHandle()),
        shed: () => resolve(shedResponse("queue-timeout")),
        timer: setTimer(() => {
          if (waiter.settled) return
          waiter.settled = true
          const i = queue.indexOf(waiter)
          if (i >= 0) queue.splice(i, 1)
          waiter.shed()
        }, queueTimeoutMs),
      }
      queue.push(waiter)
    })
  }

  return {
    admit,
    snapshot: () => ({ inFlight, queued: queue.length, ...stats }),
  }
}
