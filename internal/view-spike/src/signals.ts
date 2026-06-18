/**
 * VIEW SPIKE — minimal fine-grained signals core (~120 LOC). Pull-based auto-tracking:
 * reading a signal inside an effect records the dependency; writes re-run subscribers
 * synchronously (no scheduler — spike scope; batching is a one-liner if the gate passes).
 * References: reactively / @preact/signals-core / Solid's createSignal semantics.
 */

type Effect = {
  run: () => void
  deps: Set<Set<Effect>>
}

let currentEffect: Effect | undefined

export type Signal<T> = {
  (): T
  set(next: T | ((prev: T) => T)): void
}

export function signal<T>(initial: T): Signal<T> {
  let value = initial
  const subs = new Set<Effect>()
  const read = (() => {
    const e = currentEffect
    if (e !== undefined) {
      subs.add(e)
      e.deps.add(subs)
    }
    return value
  }) as Signal<T>
  read.set = (next) => {
    const resolved = typeof next === "function" ? (next as (p: T) => T)(value) : next
    if (Object.is(resolved, value)) return
    value = resolved
    // Snapshot: an effect re-run may resubscribe; iterating the live set would loop.
    for (const e of [...subs]) e.run()
  }
  return read
}

export function computed<T>(fn: () => T): () => T {
  const out = signal<T>(undefined as T)
  effect(() => out.set(fn()))
  return () => out()
}

export function effect(fn: () => void): () => void {
  const e: Effect = {
    deps: new Set(),
    run: () => {
      // Re-tracking: drop stale deps, re-collect during this run.
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
  }
}
