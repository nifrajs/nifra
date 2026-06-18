import type { RenderProps } from "@nifrajs/web"
import { type ComponentType, h, type VNode } from "preact"

/**
 * Fold a layout chain (outermost layout → page) into a single Preact tree: the page (innermost)
 * receives `props` (the loader data); each layout wraps the child via its `children` (Preact passes
 * the 3rd `h` arg as `props.children`). Shared by the server adapter (renderToReadableStream) and
 * the client (hydrate / mountRouter) — the Preact analogue of the React adapter's `compose`.
 */
export function compose(chain: readonly unknown[], props: RenderProps): VNode {
  const last = chain.length - 1
  // The chain holds opaque framework components; cast at this plumbing boundary. The page gets the
  // loader props (typed via ComponentType<RenderProps>), then we widen `h`'s VNode<Attributes &
  // RenderProps> to the uniform VNode the fold accumulates into. Preact's VNode<P> is invariant in P
  // under exactOptionalPropertyTypes, so the widen needs the explicit `as VNode` (a comparability
  // cast — Attributes & RenderProps is assignable to {}, so this is not an unsafe coercion).
  let node: VNode = h(chain[last] as ComponentType<RenderProps>, props) as VNode
  for (let i = last - 1; i >= 0; i--) {
    // children passed as the 3rd arg — Preact's canonical form (mirrors the React adapter).
    node = h(chain[i] as ComponentType, null, node)
  }
  return node
}
