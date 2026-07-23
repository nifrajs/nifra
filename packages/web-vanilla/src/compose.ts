import type { RenderProps } from "@nifrajs/web"
import type { Template } from "./html.ts"

/**
 * A vanilla "component": a plain function from props to a {@link Template}. The page (innermost
 * chain element) receives the loader {@link RenderProps}; a layout receives `{ children }` — the
 * already-rendered inner fragment — plus the same render props, mirroring the React/Preact
 * adapters' `children` contract.
 */
export type VanillaComponent = (props: RenderProps & { children?: Template }) => Template

/**
 * Fold a layout chain (outermost layout → page) into one {@link Template}: render the page with
 * the loader props, then wrap upward, each layout receiving the inner fragment as `children`.
 */
export function compose(chain: readonly unknown[], props: RenderProps): Template {
  const last = chain.length - 1
  let node = (chain[last] as VanillaComponent)(props)
  for (let i = last - 1; i >= 0; i--) {
    // Each layout receives its own loader data at its own index. Layouts are the chain's leading
    // prefix, so `layoutData[i]` belongs to `chain[i]`; anything past that end (a client-only `_error`
    // boundary marker, the page) reads `undefined` and is unaffected.
    node = (chain[i] as VanillaComponent)({
      ...props,
      data: props.layoutData?.[i] ?? null,
      children: node,
    })
  }
  return node
}
