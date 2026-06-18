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
    node = (chain[i] as VanillaComponent)({ ...props, children: node })
  }
  return node
}
