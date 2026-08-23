/**
 * `@nifrajs/web/nano` - the smallest state layer that still lets an island drive a keyed list.
 *
 * The islands lane (`@nifrajs/web/islands`) is imperative and correct-by-construction, but it has no
 * state primitive: every DOM update is hand-written, and a list means rebuilding the whole container.
 * nano adds a small, closed set of primitives and stops:
 *
 *   - `signal(v)`  - a current-value cell you read with `.get()` and write with `.set()`.
 *   - `computed(fn, [deps])` - a derived cell. Its dependencies are DECLARED, never auto-tracked.
 *   - `resource(fetcher, [deps])` - an async cell with an explicit pending/error/ready value. This is
 *     nano's answer to "suspense": no thrown promise, no magic boundary, just a value you can bind.
 *   - `bind` / `bindList` / `bindResource` - explicit, one-directional DOM bindings that each return
 *     their teardown.
 *
 * The design rule is the whole point: every reactive edge is a call you can see - a `bind(...)` or a
 * `computed(fn, [deps])`. There is no re-render scope, no VDOM, no template compiler, and no effect
 * that silently subscribes to whatever it happened to read. That is what removes the three failure
 * modes an AI (or a human) hits in a framework - stale closures, wrong effect deps, hydration
 * mismatch - and, just as importantly, it is what makes every remaining mistake STATICALLY
 * detectable: a missing dep is `[deps]` that doesn't list a signal the body reads; a leak is a `bind`
 * whose cleanup isn't returned. A framework's reactivity can't be linted like that; nano's can.
 *
 * Where nano stops: no client router and no nested/composable view state (a component tree that mounts
 * and unmounts its own children). When an app needs those, it has outgrown a vanilla page - reach for
 * a framework adapter (`@nifrajs/web-preact`), not more nano.
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

/** The three states of an async cell. A discriminated union on `status` so a consumer must handle
 * every branch - there is no "value that might secretly be loading", the failure mode of ad-hoc
 * `isLoading` booleans. `value`/`error` are narrowed by `status`. */
export type ResourceState<T> =
  | { readonly status: "pending"; readonly value: undefined; readonly error: undefined }
  | { readonly status: "ready"; readonly value: T; readonly error: undefined }
  | { readonly status: "error"; readonly value: undefined; readonly error: unknown }

/** An async cell: a `Readable` of `ResourceState<T>` plus `refetch()`. This is nano's answer to
 * "suspense" - an explicit pending/error/ready value, never a thrown promise or a magic boundary. */
export interface Resource<T> extends Readable<ResourceState<T>> {
  refetch(): void
}

/**
 * An async derived cell. `resource(fetcher, [deps])` runs `fetcher` immediately and again whenever a
 * declared dependency changes, exposing the result as an explicit `{ status, value, error }`.
 *
 * Two footguns are handled here so they cannot be got wrong by hand:
 *   - Races: each run holds a generation; a stale run's resolution is dropped, and its `AbortSignal` is
 *     aborted, so an earlier-started-later-finishing fetch never overwrites a newer one.
 *   - Deps: like `computed`, dependencies are DECLARED (`NF-C023` checks the fetcher's `.get()` reads
 *     against the array). A `resource` that reads a signal its deps omit won't refetch when it changes.
 */
export function resource<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: readonly Readable<unknown>[] = [],
): Resource<T> {
  const state = signal<ResourceState<T>>({ status: "pending", value: undefined, error: undefined })
  let generation = 0
  let controller: AbortController | undefined
  const run = (): void => {
    const mine = ++generation
    controller?.abort()
    controller = new AbortController()
    const active = controller
    state.set({ status: "pending", value: undefined, error: undefined })
    fetcher(active.signal).then(
      (value) => {
        if (mine === generation) state.set({ status: "ready", value, error: undefined })
      },
      (error) => {
        // A stale run (superseded) or one we aborted must not surface as an error state.
        if (mine === generation && !active.signal.aborted)
          state.set({ status: "error", value: undefined, error })
      },
    )
  }
  for (const dep of deps) dep.subscribe(run)
  run()
  return {
    get: () => state.get(),
    subscribe: (listener) => state.subscribe(listener),
    refetch: run,
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

/** How a `bindResource` maps each async state to the DOM. `ready` is required (there is always a
 * success shape to render); `pending`/`error` are optional. Every branch is explicit - no hidden
 * "still loading" state can slip through as a rendered `undefined`. */
export interface BindResourceHandlers<T> {
  ready(el: HTMLElement, value: T): void
  pending?(el: HTMLElement): void
  error?(el: HTMLElement, error: unknown): void
}

/**
 * Bind an element to a `resource`, dispatching on `status`. Like `bind`, it applies immediately and
 * on every change and returns the unsubscribe - collect it (a discarded disposer is `NF-C021`).
 *
 *   bindResource(el, user, {
 *     pending: (n) => { n.textContent = "Loading…" },
 *     ready: (n, u) => { n.textContent = u.name },
 *     error: (n) => { n.textContent = "Failed to load" },
 *   })
 */
export function bindResource<T>(
  el: HTMLElement,
  source: Readable<ResourceState<T>>,
  handlers: BindResourceHandlers<T>,
): () => void {
  return bind(el, source, (node, state) => {
    if (state.status === "pending") handlers.pending?.(node)
    else if (state.status === "error") handlers.error?.(node, state.error)
    else handlers.ready(node, state.value)
  })
}
