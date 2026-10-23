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

const watchers = new WeakMap<AbortSignal, Set<() => void>>()

/**
 * Calls `onAbort` when `signal` aborts, until the returned function is called. A signal gets one
 * native listener that every watcher shares: adding and removing a native listener per hole
 * invocation cost more under load than the invocation's own bookkeeping.
 */
export function watchAbort(signal: AbortSignal, onAbort: () => void): () => void {
  let watching = watchers.get(signal)
  if (watching === undefined) {
    const created = new Set<() => void>()
    watching = created
    watchers.set(signal, created)
    signal.addEventListener(
      "abort",
      () => {
        for (const watcher of created) watcher()
      },
      { once: true },
    )
  }
  const set = watching
  set.add(onAbort)
  return () => {
    set.delete(onAbort)
  }
}

/** A boundary's count, kept once made: an invocation changes its own count with no map lookup. */
interface Count {
  n: number
}

const countOf = (counts: Map<string, Count>, key: string): Count => {
  let count = counts.get(key)
  if (count === undefined) {
    count = { n: 0 }
    counts.set(key, count)
  }
  return count
}

const nonZero = (counts: Map<string, Count>): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const [key, count] of counts) if (count.n !== 0) out[key] = count.n
  return out
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
  readonly #pendingBy = new Map<string, Count>()
  readonly #abandonedBy = new Map<string, Count>()
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
    const mine = this.#abandonedBy.get(key)?.n ?? 0
    if (this.#abandoned >= this.#options.processAbandonedTrip && mine > 0) return "process"
    if (mine >= this.#options.boundaryAbandonedTrip) return "boundary"
    return undefined
  }

  /** @internal Counts one denial. */
  countDenied(level: DenialLevel): void {
    this.#denied[level]++
  }

  /**
   * @internal Runs one admitted invocation, counted until its promise settles. Once its signal has
   * been aborted for `abandonGraceMs` it is abandoned and `onDone` fires; `onDone` fires again when
   * it settles. The result settles with the loader, or at once when the signal aborts first: a
   * response never waits on a loader that ignores its signal. One promise and one abort watcher per
   * invocation; a chain of them cost more than the loaders the bench page runs.
   */
  invoke<T>(
    key: string,
    signal: AbortSignal,
    load: () => T | Promise<T>,
    onDone: () => void,
    watch: (onAbort: () => void) => () => void,
  ): Promise<HoleRun<T>> {
    this.#pending++
    const pending = countOf(this.#pendingBy, key)
    pending.n++
    return new Promise<HoleRun<T>>((resolve) => {
      let answered = false
      const answer = (run: HoleRun<T>): void => {
        if (answered) return
        answered = true
        resolve(run)
      }
      let abandoned: Count | undefined
      let abortedAt: number | undefined
      let timer: unknown
      const onAbort = (): void => {
        abortedAt = this.#timers.now()
        timer = this.#timers.setTimeout(() => {
          abandoned = countOf(this.#abandonedBy, key)
          abandoned.n++
          this.#abandoned++
          onDone()
        }, this.#options.abandonGraceMs)
        answer({ ok: false, reason: "aborted", error: signal.reason })
      }
      let unwatch: (() => void) | undefined
      if (signal.aborted) onAbort()
      else unwatch = watch(onAbort)
      const settle = (): void => {
        unwatch?.()
        if (timer !== undefined) this.#timers.clearTimeout(timer)
        this.#pending--
        pending.n--
        if (abandoned !== undefined) {
          this.#abandoned--
          abandoned.n--
        }
        if (abortedAt !== undefined) {
          const late = this.#timers.now() - abortedAt
          if (late > this.#options.abandonGraceMs) this.#onLateSettle?.(key, late)
        }
        onDone()
      }
      // `then` turns a synchronous throw into this invocation's rejection.
      Promise.resolve()
        .then(load)
        .then(
          (value) => {
            settle()
            answer({ ok: true, value })
          },
          (error: unknown) => {
            settle()
            answer({ ok: false, reason: signal.aborted ? "aborted" : "failed", error })
          },
        )
    })
  }

  stats(): PprAdmissionStats {
    return {
      slotsInUse: this.#slotsInUse,
      pending: this.#pending,
      abandoned: this.#abandoned,
      pendingBy: nonZero(this.#pendingBy),
      abandonedBy: nonZero(this.#abandonedBy),
      denied: { ...this.#denied },
      shed: this.#shed,
      admissionStopped: this.#abandoned >= this.#options.admissionStop,
    }
  }
}

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
   * `watch` reports that abort; the caller that aborts the signal itself passes its own.
   */
  run<T>(
    key: string,
    signal: AbortSignal,
    load: () => T | Promise<T>,
    watch: (onAbort: () => void) => () => void = (onAbort) => watchAbort(signal, onAbort),
  ): Promise<HoleRun<T>> {
    if (this.#sealed) throw new Error("[nifra/web] ppr: a sealed hole slot cannot start a hole")
    if (signal.aborted) return Promise.resolve({ ok: false, reason: "aborted" })
    const level = this.#admission.denial(key)
    if (level !== undefined) {
      this.#admission.countDenied(level)
      return Promise.resolve({ ok: false, reason: "denied" })
    }
    this.#outstanding++
    let done = false
    return this.#admission.invoke(
      key,
      signal,
      load,
      () => {
        if (done) return
        done = true
        this.#outstanding--
        this.#maybeRelease()
      },
      watch,
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
