import type { RenderProps } from "@nifrajs/web"
import { type Component, createComponent, type JSX } from "solid-js"
import { SearchContext } from "./router.ts"

// Frozen empty search so a render with no search context has a stable provider value.
const EMPTY_SEARCH: Readonly<Record<string, unknown>> = Object.freeze({})

/**
 * Fold a layout chain (outermost layout → page) into a single Solid tree: the page
 * (innermost) receives `props` (the loader data); each layout wraps the child via its
 * `children`. The whole tree is wrapped in a {@link SearchContext} provider carrying an accessor of the
 * validated `search` (threaded through `RenderProps` identically on SSR + client), so `useSearch` reads
 * the same value on both sides - no hydration mismatch. Shared by the server adapter (renderToString) and
 * the client (hydrate).
 */
export function compose(chain: readonly unknown[], props: RenderProps): () => JSX.Element {
  const last = chain.length - 1
  let node: () => JSX.Element = () => createComponent(chain[last] as Component<RenderProps>, props)
  for (let i = last - 1; i >= 0; i--) {
    const Layout = chain[i] as Component<{ children: JSX.Element }>
    const child = node
    // Each layout receives its own loader data at its own index. Layouts are the chain's leading
    // prefix, so `layoutData[i]` belongs to `chain[i]`; anything past that end (a client-only `_error`
    // boundary marker, the page) reads `undefined` and is unaffected.
    const layoutData = props.layoutData?.[i] ?? null
    node = () =>
      createComponent(Layout, {
        data: layoutData,
        ...(props.boundaries !== undefined ? { boundaries: props.boundaries } : {}),
        children: child(),
      })
  }
  const inner = node
  // The provider `value` is an ACCESSOR reading `props.search` - a getter over the mount's snapshot on
  // the client (so a same-route search change updates in place), a static value on SSR.
  return () =>
    createComponent(SearchContext.Provider, {
      value: () => (props.search ?? EMPTY_SEARCH) as Record<string, unknown>,
      get children() {
        return inner()
      },
    })
}
