/**
 * Fine-grained signals — the reactive core of `@nifrajs/islets`. Pull-based auto-tracking with
 * per-run re-tracking (a branch switch drops the stale branch's subscriptions), `Object.is`
 * equality skips, and an explicit synchronous {@link batch} that coalesces effect re-runs.
 *
 * Deliberately tiny and synchronous: writes outside `batch` re-run subscribers immediately —
 * predictable for island-scale code (a counter, a filter drawer), and the whole core stays well
 * under a kilobyte. This is NOT a general app framework; the gate analysis lives in
 * `internal/view-spike/VIEW-SPIKE.md`.
 */

interface EffectNode {
  run: () => void
  readonly deps: Set<Set<EffectNode>>
}

let currentEffect: EffectNode | undefined

let batchDepth = 0
const pendingEffects = new Set<EffectNode>()

/** A readable/writable reactive value: call it to read (tracking), `.set` to write. */
export type Signal<T> = {
  (): T
  set(next: T | ((prev: T) => T)): void
}

const scheduleEffect = (e: EffectNode): void => {
  if (batchDepth > 0) {
    pendingEffects.add(e)
  } else {
    e.run()
  }
}

/**
 * Batch writes: effects triggered inside `fn` run ONCE after it returns, deduplicated — so
 * `setA(); setB()` updates the DOM once, not twice. Re-entrant; an effect re-queued during the
 * flush runs in the same flush.
 */
export function batch<T>(fn: () => T): T {
  batchDepth++
  try {
    return fn()
  } finally {
    batchDepth--
    if (batchDepth === 0) {
      while (pendingEffects.size > 0) {
        const [next] = pendingEffects
        pendingEffects.delete(next as EffectNode)
        ;(next as EffectNode).run()
      }
    }
  }
}

/** Create a signal. Reads inside an {@link effect} (or {@link computed}) subscribe automatically. */
export function signal<T>(initial: T): Signal<T> {
  let value = initial
  const subs = new Set<EffectNode>()
  const read = (() => {
    const e = currentEffect
    if (e !== undefined) {
      subs.add(e)
      e.deps.add(subs)
    }
    return value
  }) as Signal<T>
  read.set = (next) => {
    const resolved = typeof next === "function" ? (next as (prev: T) => T)(value) : next
    if (Object.is(resolved, value)) return
    value = resolved
    // Snapshot: an effect re-run may resubscribe; iterating the live set would loop.
    for (const e of [...subs]) scheduleEffect(e)
  }
  return read
}

/** Derived value, cached into a signal — recomputes when its tracked inputs change. */
export function computed<T>(fn: () => T): () => T {
  const out = signal<T>(undefined as T)
  effect(() => out.set(fn()))
  return () => out()
}

/**
 * Run `fn` now and again whenever any signal it read changes. Returns a disposer. Dependencies
 * re-track on every run, so conditional reads subscribe to exactly the live branch.
 */
export function effect(fn: () => void): () => void {
  const e: EffectNode = {
    deps: new Set(),
    run: () => {
      for (const subs of e.deps) subs.delete(e)
      e.deps.clear()
      const prev = currentEffect
      currentEffect = e
      try {
        fn()
      } finally {
        currentEffect = prev
      }
    },
  }
  e.run()
  return () => {
    for (const subs of e.deps) subs.delete(e)
    e.deps.clear()
    pendingEffects.delete(e)
  }
}
