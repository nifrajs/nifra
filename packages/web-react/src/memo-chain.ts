import type { RenderProps } from "@nifrajs/web"
import { type ComponentType, memo, type ReactNode } from "react"

/** What a layout in a route's chain renders with. */
export type LayoutProps = {
  readonly data: unknown
  readonly boundaries?: RenderProps["boundaries"] | undefined
  readonly children?: ReactNode
}
// One `memo` per component, so its type stays the same across renders.
const memoized = <P extends object>(): ((component: ComponentType<P>) => ComponentType<P>) => {
  const held = new WeakMap<ComponentType<P>, ComponentType<P>>()
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
