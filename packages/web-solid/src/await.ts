import type { Deferred } from "@nifrajs/web"
/**
 * `@nifrajs/web-solid/await` - the `<Await>` primitive for deferred loader data (`defer()`). Isomorphic
 * and imports only `solid-js` + a type from `@nifrajs/web` (never `@solidjs/web`'s server or the compiler
 * plugin), so route components can use it without dragging server/build code into the client bundle.
 * No JSX (the package builds with plain `tsc`).
 *
 * Solid streams the boundary natively: on the server a memo over the deferred promise suspends,
 * `<Loading>` flushes the fallback then the resolved content mid-stream, and Solid serializes the
 * settled value into its hydration data - so the client hydrates the streamed content without a
 * re-fetch (it adopts the serialized answer, not the registry promise).
 */
import type { JSX } from "@solidjs/web"
import { createComponent, createMemo, Errored, Loading } from "solid-js"

export interface AwaitProps<T> {
  /** A `Deferred<T>` from a loader's `defer(...)`, or an already-resolved value (client nav). */
  readonly resolve: Deferred<T> | T
  readonly fallback?: JSX.Element
  /** Rendered if the deferred rejects. Without it the error propagates to the nearest
   * `<Errored>`. */
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
  // A memo over a promise is pending until it lands; reading it under `<Loading>` suspends there.
  const data = createMemo(() => marker.promise)
  const content = (): JSX.Element =>
    createComponent(Loading, {
      get fallback() {
        return props.fallback
      },
      get children() {
        const value = data()
        return value === undefined ? null : props.children(value)
      },
    })
  const errorFallback = props.errorFallback
  return errorFallback === undefined
    ? content()
    : createComponent(Errored, {
        fallback: (error: () => unknown) => errorFallback(error()),
        get children() {
          return content()
        },
      })
}
