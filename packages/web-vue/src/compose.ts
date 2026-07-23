import type { RenderProps } from "@nifrajs/web"
import { type Component, h, type VNode } from "vue"

/**
 * Fold a layout chain (outermost layout → page) into a single Vue VNode: the page (innermost)
 * receives `props` (the loader data); each layout wraps the child via its default slot. Shared by
 * the server adapter (renderToWebStream) and the client (hydrate / mountRouter) — the Vue analogue
 * of the React adapter's `compose`.
 */
export function compose(chain: readonly unknown[], props: RenderProps): VNode {
  const last = chain.length - 1
  let node: VNode = h(chain[last] as Component, { ...props })
  for (let i = last - 1; i >= 0; i--) {
    const child = node
    // Layouts render their child via the default slot (`<slot />` / `{@render children}`).
    // Each layout receives its own loader data at its own index. Layouts are the chain's leading
    // prefix, so `layoutData[i]` belongs to `chain[i]`; anything past that end (a client-only `_error`
    // boundary marker, the page) reads `undefined` and is unaffected.
    node = h(
      chain[i] as Component,
      { data: props.layoutData?.[i] ?? null },
      { default: () => child },
    )
  }
  return node
}
