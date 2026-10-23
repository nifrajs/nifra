import { type ComponentChildren, createElement, Fragment, type VNode } from "preact"

/**
 * `node` as a root whose `useId`s start with `prefix`, so a hole rendered and hydrated as its own root
 * never repeats an id of the page's. Preact has no option for it: `useId` counts on the nearest vnode
 * holding a counter, `__m` in Preact 10 and 11, and seeds `[0, 0]` at the root when none does.
 */
export function idScope(node: ComponentChildren, prefix: string | undefined): VNode {
  const root = createElement(Fragment, null, node)
  if (prefix !== undefined) Reflect.set(root, "__m", [prefix, 0])
  return root
}
