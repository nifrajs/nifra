/**
 * `@nifrajs/web/nano` - the smallest state layer that still lets an island drive a keyed list.
 *
 * The islands lane (`@nifrajs/web/islands`) is imperative and correct-by-construction, but it has no
 * state primitive: every DOM update is hand-written, and a list means rebuilding the whole container.
 * nano adds exactly three things and stops:
 *
 *   - `signal(v)`  - a current-value cell you read with `.get()` and write with `.set()`.
 *   - `computed(fn, [deps])` - a derived cell. Its dependencies are DECLARED, never auto-tracked.
 *   - `bind` / `bindList` - explicit, one-directional DOM bindings that each return their teardown.
 *
 * The design rule is the whole point: every reactive edge is a call you can see - a `bind(...)` or a
 * `computed(fn, [deps])`. There is no re-render scope, no VDOM, no template compiler, and no effect
 * that silently subscribes to whatever it happened to read. That is what removes the three failure
 * modes an AI (or a human) hits in a framework - stale closures, wrong effect deps, hydration
 * mismatch - and, just as importantly, it is what makes every remaining mistake STATICALLY
 * detectable: a missing dep is `[deps]` that doesn't list a signal the body reads; a leak is a `bind`
 * whose cleanup isn't returned. A framework's reactivity can't be linted like that; nano's can.
 *
 * Where nano stops: no client router, no nested view state, no suspense. When an app needs those, it
 * has outgrown a vanilla page - reach for a framework adapter (`@nifrajs/web-preact`), not more nano.
 *
 * Browser code: it touches the DOM and is meant to run in an island enhancer, never under SSR.
 */

/** A value you can read now and be told about later. Both `signal` and `computed` are `Readable`, so
 * `bind`/`bindList` accept either. */
export interface Readable<T> {
  get(): T
  subscribe(listener: (value: T) => void): () => void
}

/** A writable cell. `set` notifies subscribers only when the value actually changes (`Object.is`), so
 * a redundant write costs nothing. */
export interface Signal<T> extends Readable<T> {
  set(value: T): void
}

/** Notify a snapshot of the current listeners, so a listener that (un)subscribes mid-dispatch does not
 * corrupt the walk. A throwing listener is isolated - it never blocks the others. */
function notify<T>(listeners: Set<(value: T) => void>, value: T): void {
  for (const listener of [...listeners]) {
    try {
      listener(value)
    } catch (error) {
      console.error("[nifra/nano] a subscriber threw:", error)
    }
  }
}

/** A current-value cell. `signal(0)` -> `.get()` reads, `.set(1)` writes and notifies. */
export function signal<T>(initial: T): Signal<T> {
  let value = initial
  const listeners = new Set<(value: T) => void>()
  return {
    get: () => value,
    set(next: T) {
      if (Object.is(next, value)) return
      value = next
      notify(listeners, value)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * A derived cell. `computed(() => a.get() + b.get(), [a, b])` recomputes whenever a declared
 * dependency changes and notifies its own subscribers when the derived value changes.
 *
 * The `deps` array is mandatory and explicit ON PURPOSE - it is the contract a linter checks against
 * the signals the body reads (`NF-C023`). Auto-tracking would remove the array but reintroduce the
 * exact "why didn't this update" bug that makes framework reactivity hard to get right.
 */
export function computed<T>(compute: () => T, deps: readonly Readable<unknown>[]): Readable<T> {
  let value = compute()
  const listeners = new Set<(value: T) => void>()
  const recompute = (): void => {
    const next = compute()
    if (Object.is(next, value)) return
    value = next
    notify(listeners, value)
  }
  // A computed with a live subscriber must itself be subscribed to its deps; to keep the prototype
  // simple it subscribes eagerly for its whole life (fine for the island-scoped, few-signal case).
  for (const dep of deps) dep.subscribe(recompute)
  return {
    get: () => value,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * Bind one element to a source: `apply(el, value)` runs once immediately and again on every change.
 * Returns the unsubscribe - hand it back as the island's cleanup (or collect several).
 *
 *   bind(count, remaining, (el, n) => { el.textContent = String(n) })
 */
export function bind<T>(
  el: HTMLElement,
  source: Readable<T>,
  apply: (el: HTMLElement, value: T) => void,
): () => void {
  apply(el, source.get())
  return source.subscribe((value) => apply(el, value))
}

/** How a `bindList` turns items into keyed DOM. `key` MUST be stable and unique per item (never the
 * array index) - it is what lets add/remove/reorder touch only the changed rows. */
export interface BindListOptions<T> {
  key(item: T): string | number
  create(item: T): HTMLElement
  update?(el: HTMLElement, item: T): void
}

/**
 * Bind a list signal to a container with keyed reconciliation: new items are `create`d, surviving
 * items are `update`d in place (keeping focus, scroll, and selection), removed items are detached,
 * and the children are ordered to match the array. Returns the unsubscribe.
 *
 * This is the one imperative task too error-prone to hand-write each time - it is why nano exists on
 * top of islands rather than leaving you to rebuild the container on every change.
 */
export function bindList<T>(
  source: Readable<readonly T[]>,
  container: HTMLElement,
  options: BindListOptions<T>,
): () => void {
  let nodes = new Map<string | number, HTMLElement>()
  const render = (items: readonly T[]): void => {
    const next = new Map<string | number, HTMLElement>()
    for (const item of items) {
      const key = options.key(item)
      const el = nodes.get(key) ?? options.create(item)
      options.update?.(el, item)
      next.set(key, el)
    }
    for (const [key, el] of nodes) if (!next.has(key)) el.remove()
    // Append in item order; appending an already-attached node MOVES it, so the final order matches.
    for (const item of items) container.appendChild(next.get(options.key(item)) as HTMLElement)
    nodes = next
  }
  render(source.get())
  return source.subscribe(render)
}
