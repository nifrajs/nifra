import type { Deferred } from "@nifrajs/web"
/**
 * `@nifrajs/web-solid/await` — the `<Await>` primitive for deferred loader data (`defer()`). Isomorphic
 * and imports only `solid-js` + a type from `@nifrajs/web` (never `solid-js/web`'s server or the Babel
 * plugin), so route components can use it without dragging server/build code into the client bundle.
 * No JSX (the package builds with plain `tsc`).
 *
 * Solid streams the boundary natively: on the server `createResource` awaits the deferred promise,
 * `<Suspense>` flushes the fallback then the resolved content mid-stream, and Solid serializes the
 * resource value into its hydration data — so the client hydrates the streamed content without a
 * re-fetch (it reads `_$HY`, not the registry promise).
 */
import { createComponent, createResource, type JSX, Suspense } from "solid-js"

export interface AwaitProps<T> {
  /** A `Deferred<T>` from a loader's `defer(...)`, or an already-resolved value (client nav). */
  readonly resolve: Deferred<T> | T
  readonly fallback?: JSX.Element
  /** Rendered if the deferred rejects. Without it the error propagates to the nearest
   * `<ErrorBoundary>`. */
  readonly errorFallback?: (error: unknown) => JSX.Element
  readonly children: (value: T) => JSX.Element
}

function isDeferred<T>(value: Deferred<T> | T): value is Deferred<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __nifra_deferred?: unknown }).__nifra_deferred === true
  )
}

/**
 * Render deferred loader data: show `fallback` until the `Deferred` settles (streamed in by the
 * server), then `children(value)`. An already-resolved `resolve` (a client navigation awaited it)
 * renders immediately. Pairs with a loader's `defer(...)`.
 */
export function Await<T>(props: AwaitProps<T>): JSX.Element {
  if (!isDeferred(props.resolve)) return props.children(props.resolve)
  const marker = props.resolve
  const [data] = createResource(() => marker.promise)
  return createComponent(Suspense, {
    get fallback() {
      return props.fallback
    },
    get children() {
      // Errored? Render `errorFallback`, else rethrow to an outer <ErrorBoundary>. Check `data.error`
      // BEFORE `data()` (which would rethrow). Otherwise: `data()` suspends until the resource
      // settles (on the client Solid reads the serialized value — no re-fetch).
      if (data.error !== undefined) {
        if (props.errorFallback) return props.errorFallback(data.error)
        throw data.error
      }
      const value = data()
      return value === undefined ? null : props.children(value)
    },
  })
}
