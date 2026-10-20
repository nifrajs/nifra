/**
 * Fine-grained signals - the reactive core of `@nifrajs/islets`. Pull-based auto-tracking with
 * per-run re-tracking (a branch switch drops the stale branch's subscriptions), `Object.is`
 * equality skips, and an explicit synchronous {@link batch} that coalesces effect re-runs.
 *
 * Deliberately tiny and synchronous: a write recomputes the computeds it feeds at once and runs its
 * effects before `set` returns, each once, after every computed has settled - predictable for
 * island-scale code (a counter, a filter drawer), and the whole core stays well under a kilobyte.
 * This is NOT a general app framework - just island-scale reactivity.
 */

interface EffectNode {
  run: () => void
  /** Each source's reader set, mapped to the run (`v`) that last read it. */
  readonly deps: Map<Set<EffectNode>, number>
  v: number
  /** Sources read so far in this run. */
  n: number
  /** Running now: a write during the run requeues it only for a source this run already read. */
  r?: boolean
  /** Set on a computed's node: it recomputes on the write instead of queueing. */
  readonly c?: boolean | undefined
  /** Queued for the current flush. */
  q?: boolean
}

let currentEffect: EffectNode | undefined

// Collects the disposers of the effects (so also computeds) created while an island's setup and
// bindings run, so unmounting the island stops them.
let owner: Array<() => void> | undefined

/** Run `fn` with the disposer of every effect and computed it creates pushed onto `kids`. */
export function owned<T>(kids: Array<() => void>, fn: () => T): T {
  const prev = owner
  owner = kids
  try {
    return fn()
  } finally {
    owner = prev
  }
}

/** Run `fn` without subscribing the running effect or computed to the signals it reads. */
export function untrack<T>(fn: () => T): T {
  const prev = currentEffect
  currentEffect = undefined
  try {
    return fn()
  } finally {
    currentEffect = prev
  }
}

let batchDepth = 0
const queue: EffectNode[] = []

/** A readable/writable reactive value: call it to read (tracking), `.set` to write. */
export type Signal<T> = {
  (): T
  set(next: T | ((prev: T) => T)): void
}

/**
 * Batch writes: effects triggered inside `fn` run ONCE after it returns, deduplicated - so
 * `setA(); setB()` updates the DOM once, not twice. Re-entrant; an effect re-queued during the
 * flush runs in the same flush.
 */
export function batch<T>(fn: () => T): T {
  batchDepth++
  try {
    return fn()
  } finally {
    flush()
  }
}

// Closes one batch level; the outermost runs the queue.
function flush(): void {
  let i = 0
  try {
    // The flush still counts as a batch: a write an effect makes here queues, so none runs twice.
    while (batchDepth === 1 && i < queue.length) {
      const next = queue[i++] as EffectNode
      if (next.q) {
        next.q = false
        next.run()
      }
    }
  } finally {
    // A throwing effect leaves the rest queued for the next flush.
    if (i === queue.length) queue.length = 0
    else queue.splice(0, i)
    batchDepth--
  }
}

// Each plain signal's reader set, so `watch` can subscribe without tracking.
const readers = new WeakMap<Signal<unknown>, Set<EffectNode>>()

/** Create a signal. Reads inside an {@link effect} (or {@link computed}) subscribe automatically. */
export function signal<T>(initial: T): Signal<T> {
  const subs = new Set<EffectNode>()
  const s = readable(initial, subs)
  readers.set(s as Signal<unknown>, subs)
  return s
}

/**
 * Call `fn` with `source`'s value now and after each change, queued and batched like an effect but
 * subscribed once instead of tracking reads. Internal to the binding walker, whose bindings each
 * read one named signal; not exported from the package.
 */
export function watch<T>(source: Signal<T>, fn: (value: T) => void): () => void {
  const subs = readers.get(source as Signal<unknown>)
  if (!subs) return effect(() => fn(source()))
  const e: EffectNode = {
    deps: new Map([[subs, 0]]),
    v: 0,
    n: 1,
    run: () => {
      const prev = currentEffect
      currentEffect = undefined
      try {
        fn(source())
      } finally {
        currentEffect = prev
      }
    },
  }
  const stop = (): void => {
    subs.delete(e)
    e.q = false
  }
  subs.add(e)
  owner?.push(stop)
  e.run()
  return stop
}

// A signal whose readers are `subs`, so a computed can see whether anything still reads it.
function readable<T>(initial: T, subs: Set<EffectNode>): Signal<T> {
  let value = initial
  const read = (() => {
    const e = currentEffect
    if (e) {
      const seen = e.deps.get(subs)
      if (seen !== e.v) {
        if (seen === undefined) subs.add(e)
        e.deps.set(subs, e.v)
        e.n++
      }
    }
    return value
  }) as Signal<T>
  read.set = (next) => {
    const resolved = typeof next === "function" ? (next as (prev: T) => T)(value) : next
    if (Object.is(resolved, value)) return
    value = resolved
    // Snapshot: an effect created while this write flushes must not run in it.
    batchDepth++
    try {
      for (const e of [...subs]) {
        // A running effect is requeued only by a source its current run has already read.
        if (e.r && e.deps.get(subs) !== e.v) continue
        if (e.c) e.run()
        else if (!e.q) {
          e.q = true
          queue.push(e)
        }
      }
    } finally {
      flush()
    }
  }
  return read
}

/** A derived value: call it to read (tracking), `.dispose()` to stop recomputing it. */
export type Computed<T> = {
  (): T
  dispose(): void
}

/**
 * Derived value, cached into a signal and computed on first read. While an effect (or another
 * computed) reads it, it recomputes when its tracked inputs change. Once nothing reads it, the next
 * input change stops it instead of recomputing, so a dropped computed costs nothing; reading it
 * again starts it afresh. `dispose()` stops it at once.
 */
export function computed<T>(fn: () => T): Computed<T> {
  const subs = new Set<EffectNode>()
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the first read computes it before returning
  const out = readable<T>(undefined as T, subs)
  let stop: (() => void) | undefined
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: `dispose` is assigned below
  const read = (() => {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the implementation takes the computed flag its public overload hides
    stop ??= (effect as (fn: () => void, c: boolean) => () => void)(() => {
      if (!stop || subs.size) out.set(fn())
      else read.dispose()
    }, true)
    return out()
  }) as Computed<T>
  read.dispose = () => {
    stop?.()
    stop = undefined
  }
  return read
}

/**
 * Run `fn` now and again whenever any signal it read changes. Returns a disposer. Dependencies
 * re-track on every run, so conditional reads subscribe to exactly the live branch.
 */
export function effect(fn: () => void): () => void
export function effect(fn: () => void, c?: boolean): () => void {
  const stop = (): void => {
    for (const subs of e.deps.keys()) subs.delete(e)
    e.deps.clear()
    e.q = false
  }
  const e: EffectNode = {
    c,
    deps: new Map(),
    v: 0,
    n: 0,
    // Subscriptions persist across runs; a source this run did not read is dropped afterwards.
    run: () => {
      ++e.v
      e.n = 0
      e.q = false
      e.r = true
      const prev = currentEffect
      currentEffect = e
      try {
        fn()
      } finally {
        currentEffect = prev
        e.r = false
        if (e.n < e.deps.size)
          for (const [subs, seen] of e.deps)
            if (seen !== e.v) {
              subs.delete(e)
              e.deps.delete(subs)
            }
      }
    },
  }
  owner?.push(stop)
  e.run()
  return stop
}
