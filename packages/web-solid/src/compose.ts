import type { RenderProps } from "@nifrajs/web"
import { type Component, createComponent, type JSX } from "solid-js"

/**
 * Fold a layout chain (outermost layout → page) into a single Solid tree: the page
 * (innermost) receives `props` (the loader data); each layout wraps the child via its
 * `children`. Shared by the server adapter (renderToString) and the client (hydrate).
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
    node = () => createComponent(Layout, { data: layoutData, children: child() })
  }
  return node
}
