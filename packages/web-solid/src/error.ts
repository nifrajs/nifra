/**
 * `errorBoundary` — the Solid error-boundary chain element for nifra's `_error.tsx`. Its own module
 * (imports only `solid-js`) so the client codegen can import it from `@nifrajs/web-solid/client` (which
 * re-exports it). No JSX (`createComponent`), so the package builds with plain `tsc`.
 */
import { createComponent, ErrorBoundary, type JSX } from "solid-js"

/**
 * Build an error-boundary chain element bound to `fallback` (a route's `_error` component). nifra's
 * client codegen inserts it before the page in the matched chain; a render error in the subtree renders
 * `fallback` with `{ data: { name, message } }` (via Solid's `<ErrorBoundary>`) instead of crashing.
 * DOM-transparent (renders its children directly — no wrapper element), so it never disturbs hydration.
 */
export function errorBoundary(fallback: unknown): unknown {
  const Fallback = fallback as (props: { data: { name: string; message: string } }) => JSX.Element
  return (props: { children?: JSX.Element }): JSX.Element =>
    createComponent(ErrorBoundary, {
      fallback: (err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err))
        return createComponent(Fallback, { data: { name: e.name, message: e.message } })
      },
      get children() {
        return props.children
      },
    })
}
