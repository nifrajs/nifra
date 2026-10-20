import type { ResolvedPprOptions } from "./options.ts"

/** Which admission level denied an invocation, checked in this order. */
export type DenialLevel = "stop" | "process" | "boundary"

/** How one hole invocation ended, as its response sees it. */
export type HoleRun<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false
      readonly reason: "denied" | "failed" | "aborted"
      readonly error?: unknown
    }

export interface PprAdmissionStats {
  /** Responses holding a hole-work slot. */
  readonly slotsInUse: number
  /** Every invocation whose promise has not settled, abandoned ones included (`ppr.inflight_loaders`). */
  readonly pending: number
  /** The abandoned subset of {@link pending} (`ppr.abandoned_inflight`). */
  readonly abandoned: number
  readonly pendingBy: Readonly<Record<string, number>>
  readonly abandonedBy: Readonly<Record<string, number>>
  readonly denied: Readonly<Record<DenialLevel, number>>
  /** Responses that found no free slot and invoked no hole (`ppr.shed`). */
  readonly shed: number
  /** True while the global admission stop holds (`ppr.admission_stopped`). */
  readonly admissionStopped: boolean
}

type AdmissionOptions = Pick<
  ResolvedPprOptions,
  | "boundaryAbandonedTrip"
  | "processAbandonedTrip"
  | "admissionStop"
  | "abandonGraceMs"
  | "maxHoleWork"
>

/** The clock and timer admission reads; injected by tests so no test waits on the wall clock. */
export interface AdmissionTimers {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const SYSTEM_TIMERS: AdmissionTimers = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the handle came from this object's own setTimeout.
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const bump = (counts: Map<string, number>, key: string, by: number): void => {
  const next = (counts.get(key) ?? 0) + by
  if (next === 0) counts.delete(key)
  else counts.set(key, next)
}

/**
 * Bounds the hole work a process runs without letting one bad loader starve the rest.
 *
 * An invocation is abandoned once its signal aborted more than `abandonGraceMs` ago and its promise
 * is still pending; it stays counted until the promise settles. Only abandoned invocations count
 * toward a denial level, so a well-behaved boundary is denied only at the global stop. Each response
 * holds one hole-work slot from before its first invocation until every invocation has settled,
 * been denied or been abandoned, which bounds live invocations by `32 * maxHoleWork`.
 */
export class HoleAdmission {
  readonly #options: AdmissionOptions
  readonly #onLateSettle: ((key: string, msAfterAbort: number) => void) | undefined
  readonly #timers: AdmissionTimers
  readonly #pendingBy = new Map<string, number>()
  readonly #abandonedBy = new Map<string, number>()
  readonly #denied: Record<DenialLevel, number> = { stop: 0, process: 0, boundary: 0 }
  #pending = 0
  #abandoned = 0
  #slotsInUse = 0
  #shed = 0

  constructor(
    options: AdmissionOptions,
    onLateSettle?: (key: string, msAfterAbort: number) => void,
    timers: AdmissionTimers = SYSTEM_TIMERS,
  ) {
    this.#options = options
    this.#onLateSettle = onLateSettle
    this.#timers = timers
  }

  /** A hole-work slot for one response, or `undefined` when none is free (the response is shed). */
  slot(): HoleSlot | undefined {
    if (this.#slotsInUse >= this.#options.maxHoleWork) {
      this.#shed++
      return undefined
    }
    this.#slotsInUse++
    return new HoleSlot(this, () => this.#slotsInUse--)
  }

  /** The level that denies boundary `key` now, or `undefined` when it is admitted. */
  denial(key: string): DenialLevel | undefined {
    if (this.#abandoned >= this.#options.admissionStop) return "stop"
    const mine = this.#abandonedBy.get(key) ?? 0
    if (this.#abandoned >= this.#options.processAbandonedTrip && mine > 0) return "process"
    if (mine >= this.#options.boundaryAbandonedTrip) return "boundary"
    return undefined
  }

  /** @internal Counts one denial. */
  countDenied(level: DenialLevel): void {
    this.#denied[level]++
  }

  /** @internal Tracks one invocation's promise until it settles; `abandon` fires after the grace. */
  track<T>(
    key: string,
    promise: Promise<T>,
    signal: AbortSignal,
    onAbandoned: () => void,
  ): Promise<T> {
    this.#pending++
    bump(this.#pendingBy, key, 1)
    let abandoned = false
    let abortedAt: number | undefined
    let timer: unknown
    const onAbort = (): void => {
      abortedAt = this.#timers.now()
      timer = this.#timers.setTimeout(() => {
        abandoned = true
        this.#abandoned++
        bump(this.#abandonedBy, key, 1)
        onAbandoned()
      }, this.#options.abandonGraceMs)
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
    const settle = (): void => {
      signal.removeEventListener("abort", onAbort)
      if (timer !== undefined) this.#timers.clearTimeout(timer)
      this.#pending--
      bump(this.#pendingBy, key, -1)
      if (abandoned) {
        this.#abandoned--
        bump(this.#abandonedBy, key, -1)
      }
      if (abortedAt !== undefined) {
        const late = this.#timers.now() - abortedAt
        if (late > this.#options.abandonGraceMs) this.#onLateSettle?.(key, late)
      }
    }
    return promise.then(
      (value) => {
        settle()
        return value
      },
      (error: unknown) => {
        settle()
        throw error
      },
    )
  }

  stats(): PprAdmissionStats {
    return {
      slotsInUse: this.#slotsInUse,
      pending: this.#pending,
      abandoned: this.#abandoned,
      pendingBy: Object.fromEntries(this.#pendingBy),
      abandonedBy: Object.fromEntries(this.#abandonedBy),
      denied: { ...this.#denied },
      shed: this.#shed,
      admissionStopped: this.#abandoned >= this.#options.admissionStop,
    }
  }
}

/** Settles with `promise`, or as soon as `signal` aborts: a response never waits on a loader that
 * ignores its signal. */
const raceAbort = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> =>
  signal.aborted
    ? Promise.reject(signal.reason)
    : new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(signal.reason)
        signal.addEventListener("abort", onAbort, { once: true })
        promise.then(
          (value) => {
            signal.removeEventListener("abort", onAbort)
            resolve(value)
          },
          (error: unknown) => {
            signal.removeEventListener("abort", onAbort)
            reject(error)
          },
        )
      })

/** One response's hole-work slot. Released exactly once. */
export class HoleSlot {
  readonly #admission: HoleAdmission
  readonly #release: () => void
  #outstanding = 0
  #sealed = false
  #released = false

  constructor(admission: HoleAdmission, release: () => void) {
    this.#admission = admission
    this.#release = release
  }

  /**
   * Invoke one hole loader under admission. Denied, it is never invoked. Otherwise the result
   * settles with the loader, or at once when `signal` aborts while the loader is still pending.
   */
  run<T>(key: string, signal: AbortSignal, load: () => T | Promise<T>): Promise<HoleRun<T>> {
    if (this.#sealed) throw new Error("[nifra/web] ppr: a sealed hole slot cannot start a hole")
    if (signal.aborted) return Promise.resolve({ ok: false, reason: "aborted" })
    const level = this.#admission.denial(key)
    if (level !== undefined) {
      this.#admission.countDenied(level)
      return Promise.resolve({ ok: false, reason: "denied" })
    }
    this.#outstanding++
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      this.#outstanding--
      this.#maybeRelease()
    }
    // `then` turns a synchronous throw into this invocation's rejection.
    const invoked = Promise.resolve().then(load)
    const tracked = this.#admission.track(key, invoked, signal, finish)
    tracked.then(finish, finish)
    return raceAbort(tracked, signal).then(
      (value): HoleRun<T> => ({ ok: true, value }),
      (error: unknown): HoleRun<T> => ({
        ok: false,
        reason: signal.aborted ? "aborted" : "failed",
        error,
      }),
    )
  }

  /** No more holes will start for this response; the slot frees once the started ones are done. */
  seal(): void {
    this.#sealed = true
    this.#maybeRelease()
  }

  #maybeRelease(): void {
    if (this.#released || !this.#sealed || this.#outstanding > 0) return
    this.#released = true
    this.#release()
  }
}
