import type { RenderProps } from "@nifrajs/web"
import type { ComponentChildren, FunctionComponent } from "preact"
import { memo } from "preact/compat"

/** What a layout in a route's chain renders with. */
export type LayoutProps = {
  readonly data: unknown
  readonly boundaries?: RenderProps["boundaries"] | undefined
  readonly children?: ComponentChildren
}
// One `memo` per component, so its type stays the same across renders.
const memoized = <P extends object>(): ((
  component: FunctionComponent<P>,
) => FunctionComponent<P>) => {
  const held = new WeakMap<FunctionComponent<P>, FunctionComponent<P>>()
  return (component) => {
    let memoComponent = held.get(component)
    if (memoComponent === undefined) {
      memoComponent = memo(component)
      held.set(component, memoComponent)
    }
    return memoComponent
  }
}
export const memoPage = memoized<RenderProps>()
export const memoLayout = memoized<LayoutProps>()
