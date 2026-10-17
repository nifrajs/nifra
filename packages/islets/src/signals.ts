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
  readonly deps: Set<Set<EffectNode>>
  /** Set on a computed's node: it recomputes on the write instead of queueing. */
  readonly c?: boolean | undefined
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

let batchDepth = 0
const pendingEffects = new Set<EffectNode>()

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
    try {
      // The flush still counts as a batch: a write an effect makes here queues, so none runs twice.
      while (batchDepth === 1 && pendingEffects.size) {
        const [next] = pendingEffects
        pendingEffects.delete(next as EffectNode)
        ;(next as EffectNode).run()
      }
    } finally {
      batchDepth--
    }
  }
}

/** Create a signal. Reads inside an {@link effect} (or {@link computed}) subscribe automatically. */
export function signal<T>(initial: T): Signal<T> {
  return readable(initial, new Set())
}

// A signal whose readers are `subs`, so a computed can see whether anything still reads it.
function readable<T>(initial: T, subs: Set<EffectNode>): Signal<T> {
  let value = initial
  const read = (() => {
    if (currentEffect) {
      subs.add(currentEffect)
      currentEffect.deps.add(subs)
    }
    return value
  }) as Signal<T>
  read.set = (next) => {
    const resolved = typeof next === "function" ? (next as (prev: T) => T)(value) : next
    if (Object.is(resolved, value)) return
    value = resolved
    // Snapshot: a computed re-run resubscribes; iterating the live set would loop.
    batch(() => {
      for (const e of [...subs]) e.c ? e.run() : pendingEffects.add(e)
    })
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
    for (const subs of e.deps) subs.delete(e)
    e.deps.clear()
    pendingEffects.delete(e)
  }
  const e: EffectNode = {
    c,
    deps: new Set(),
    run: () => {
      stop()
      const prev = currentEffect
      currentEffect = e
      try {
        fn()
      } finally {
        currentEffect = prev
      }
    },
  }
  owner?.push(stop)
  e.run()
  return stop
}
