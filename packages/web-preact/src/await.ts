import type { Deferred } from "@nifrajs/web"
import type { ComponentChildren, VNode } from "preact"
/**
 * `@nifrajs/web-preact/await` — the `<Await>` primitive for deferred loader data (`defer()`). Isomorphic
 * and imports only `preact`/`preact/compat` + a type from `@nifrajs/web` (never the server renderer), so
 * route components can use it without dragging server code into the client bundle. No JSX (the package
 * builds with plain `tsc`).
 *
 * Preact's compat has no React 19 `use()` hook, so `readDeferred` (in `./read-deferred`) reads the
 * React-style thenable the core tags (`status`/`value`/`reason`, via the streamed
 * `__nifraResolve`/`__nifraReject`) synchronously: on the client a settled deferred renders its content
 * directly into the boundary the server streamed (no re-suspend, no fallback flash). While pending it
 * throws the promise so `<Suspense>` streams the fallback (server) / shows it until settle (client).
 */
import { Component, createElement, Suspense } from "preact/compat"
import { readDeferred, type Thenable } from "./read-deferred.ts"

export interface AwaitProps<T> {
  /** A `Deferred<T>` from a loader's `defer(...)`, or an already-resolved value (client nav). */
  readonly resolve: Deferred<T> | T
  readonly fallback?: ComponentChildren
  /** Rendered if the deferred rejects (the streamed `__nifraReject`). Without it the error
   * propagates to the nearest error boundary. */
  readonly errorFallback?: (error: unknown) => ComponentChildren
  readonly children: (value: T) => ComponentChildren
}

// Catches the rejection `readDeferred` throws when the deferred rejects → renders `errorFallback`. A
// class is required (error boundaries have no hook form). Local so `<Await>` is self-contained.
class AwaitBoundary extends Component<
  { fallback: (error: unknown) => ComponentChildren; children?: ComponentChildren },
  { caught: boolean; error: unknown }
> {
  override state: { caught: boolean; error: unknown } = { caught: false, error: undefined }
  static override getDerivedStateFromError(error: unknown): { caught: boolean; error: unknown } {
    return { caught: true, error }
  }
  override render(): ComponentChildren {
    return this.state.caught ? this.props.fallback(this.state.error) : this.props.children
  }
}

function isDeferred<T>(value: Deferred<T> | T): value is Deferred<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __nifra_deferred?: unknown }).__nifra_deferred === true
  )
}

// Type-erased (non-generic) so `createElement` infers cleanly; `Await<T>` casts at the call site.
function Resolved(props: {
  marker: Deferred<unknown>
  render: (value: unknown) => ComponentChildren
}): ComponentChildren {
  return props.render(readDeferred(props.marker.promise as Thenable<unknown>))
}

/**
 * Render deferred loader data: show `fallback` until the `Deferred` settles (streamed in by the
 * server), then `children(value)`. An already-resolved `resolve` (a client navigation awaited it)
 * renders immediately. Pairs with a loader's `defer(...)`.
 */
export function Await<T>(props: AwaitProps<T>): VNode | ComponentChildren {
  if (!isDeferred(props.resolve)) return props.children(props.resolve)
  const suspense = createElement(
    Suspense,
    { fallback: props.fallback },
    createElement(Resolved, {
      marker: props.resolve,
      // safe: the registry promise resolves to T; Resolved is type-erased to satisfy createElement.
      render: props.children as (value: unknown) => ComponentChildren,
    }),
  )
  return props.errorFallback
    ? createElement(AwaitBoundary, { fallback: props.errorFallback }, suspense)
    : suspense
}
