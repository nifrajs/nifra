import type { Deferred } from "@nifrajs/web"
/**
 * `@nifrajs/web-react/await` — the `<Await>` primitive for deferred loader data (`defer()`). Isomorphic
 * and imports only `react` + a type from `@nifrajs/web` (never `react-dom/server`), so route components
 * can use it without dragging server code into the client bundle. No JSX (the package builds with
 * plain `tsc`).
 *
 * The server streams the boundary: `use(promise)` suspends, React flushes the fallback then the
 * resolved content mid-stream. On the client the registry promise is already settled (the core's
 * streamed `__nifraResolve` script tagged it `fulfilled`), so `use()` returns the value synchronously
 * — React hydrates the server-revealed boundary's content directly (no re-fetch, no fallback flash).
 */
import { Component, createElement, type ReactNode, Suspense, use } from "react"

export interface AwaitProps<T> {
  /** A `Deferred<T>` from a loader's `defer(...)`, or an already-resolved value (client nav). */
  readonly resolve: Deferred<T> | T
  readonly fallback?: ReactNode
  /** Rendered if the deferred rejects (the streamed `__nifraReject`). Without it the error
   * propagates to the nearest error boundary. */
  readonly errorFallback?: (error: unknown) => ReactNode
  readonly children: (value: T) => ReactNode
}

// Catches the rejection `use()` throws when the deferred rejects → renders `errorFallback`. A class
// is required (React error boundaries have no hook form). Local so `<Await>` is self-contained.
class AwaitBoundary extends Component<
  { fallback: (error: unknown) => ReactNode; children?: ReactNode },
  { caught: boolean; error: unknown }
> {
  override state: { caught: boolean; error: unknown } = { caught: false, error: undefined }
  static getDerivedStateFromError(error: unknown): { caught: boolean; error: unknown } {
    return { caught: true, error }
  }
  override render(): ReactNode {
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
  render: (value: unknown) => ReactNode
}): ReactNode {
  return props.render(use(props.marker.promise))
}

/**
 * Render deferred loader data: show `fallback` until the `Deferred` settles (streamed in by the
 * server), then `children(value)`. An already-resolved `resolve` (a client navigation awaited it)
 * renders immediately. Pairs with a loader's `defer(...)`.
 */
export function Await<T>(props: AwaitProps<T>): ReactNode {
  if (!isDeferred(props.resolve)) return props.children(props.resolve)
  const suspense = createElement(
    Suspense,
    { fallback: props.fallback },
    createElement(Resolved, {
      marker: props.resolve,
      // safe: the registry promise resolves to T; Resolved is type-erased to satisfy createElement.
      render: props.children as (value: unknown) => ReactNode,
    }),
  )
  return props.errorFallback
    ? createElement(AwaitBoundary, { fallback: props.errorFallback }, suspense)
    : suspense
}
