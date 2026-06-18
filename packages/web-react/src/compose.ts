import type { RenderProps } from "@nifrajs/web"
import { createElement, type FunctionComponent, type ReactNode } from "react"

/**
 * Fold a layout chain (outermost layout → page) into a single React tree: the page
 * (innermost) receives `props` (the loader data); each layout wraps the child via its
 * `children`. Shared by the server adapter (renderToString) and the client (hydrateRoot).
 */
export function compose(chain: readonly unknown[], props: RenderProps): ReactNode {
  const last = chain.length - 1
  let node: ReactNode = createElement(chain[last] as FunctionComponent<RenderProps>, props)
  for (let i = last - 1; i >= 0; i--) {
    // children passed as the 3rd arg (not a `children` prop) — React's canonical form.
    node = createElement(chain[i] as FunctionComponent, null, node)
  }
  return node
}
