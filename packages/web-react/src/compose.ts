import type { RenderProps } from "@nifrajs/web"
import { createElement, type FunctionComponent, type ReactNode } from "react"
import { RouterContext } from "./router.ts"

// Stable empty params so the provider value's `params` has a fixed reference when a route has none.
const EMPTY_PARAMS: Readonly<Record<string, string>> = Object.freeze({})

/**
 * Fold a layout chain (outermost layout → page) into a single React tree: the page
 * (innermost) receives `props` (the loader data); each layout wraps the child via its
 * `children`. Shared by the server adapter (renderToString) and the client (hydrateRoot).
 *
 * The whole tree is wrapped in a {@link RouterContext} provider carrying the matched `params`, the
 * current `path`, and the client `pending` flag (all threaded through `RenderProps` identically on SSR
 * and client), so the routing hooks (`useParams`/`useLocation`/`useNavigation`) read the same value on
 * both sides - no hydration mismatch (`pending` is `false` on SSR and on the initial client render).
 * A render with no routing fields (a non-router adapter usage) provides the empty default.
 */
export function compose(chain: readonly unknown[], props: RenderProps): ReactNode {
  const last = chain.length - 1
  let node: ReactNode = createElement(chain[last] as FunctionComponent<RenderProps>, props)
  for (let i = last - 1; i >= 0; i--) {
    // children passed as the 3rd arg (not a `children` prop) — React's canonical form.
    node = createElement(chain[i] as FunctionComponent, null, node)
  }
  return createElement(
    RouterContext.Provider,
    {
      value: {
        params: props.params ?? EMPTY_PARAMS,
        path: props.path ?? "",
        pending: props.pending ?? false,
      },
    },
    node,
  )
}
