/**
 * The two wrappers a kept page renders inside, shared by the server render and the keep-alive mount so
 * the markup a document carries is the markup the browser hydrates. `Activity` sits between them: a
 * hidden page's effects clean up, and the inner wrapper is the element taken out of the document. Each
 * is a `<slot>`, which browsers lay out as `display: contents` with no inline style a CSP could block.
 */
import * as React from "react"
import { type ComponentType, createElement, type ReactNode, type Ref } from "react"

type ActivityComponent = ComponentType<{
  readonly mode: "hidden" | "visible"
  readonly children?: ReactNode
}>

let activity: ActivityComponent | undefined
const activityOf = (): ActivityComponent => {
  if (activity !== undefined) return activity
  const found = Reflect.get(React, "Activity")
  if (found === undefined) {
    throw new Error(
      `[nifra/web-react] keepAlive needs React 19.2 or later, which has <Activity>; this app runs React ${React.version}. Upgrade react and react-dom, or remove the keepAlive export.`,
    )
  }
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: React's own export, read by name so an older React fails with the message above rather than at import
  activity = found as ActivityComponent
  return activity
}

/** `content` inside the slot wrappers, hidden or shown. */
export function inSlot(
  hidden: boolean,
  content: ReactNode,
  entryRef?: Ref<HTMLSlotElement>,
  pageRef?: Ref<HTMLSlotElement>,
): ReactNode {
  return createElement(
    "slot",
    { "data-nifra-entry": "", ref: entryRef },
    createElement(
      activityOf(),
      { mode: hidden ? "hidden" : "visible" },
      createElement("slot", { "data-nifra-page": "", ref: pageRef }, content),
    ),
  )
}

const slotted = new WeakMap<object, ComponentType<Record<string, unknown>>>()

/** `chain` with the entries at `slots` rendered inside the slot wrappers (the server's half). */
export function slottedChain(chain: readonly unknown[], slots: readonly number[]): unknown[] {
  return chain.map((component, depth) => {
    if (
      !slots.includes(depth) ||
      (typeof component !== "function" && typeof component !== "object")
    )
      return component
    if (component === null) return component
    let wrapped = slotted.get(component)
    if (wrapped === undefined) {
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a chain entry is a route or layout module's default export, a component
      const Component = component as ComponentType<Record<string, unknown>>
      wrapped = (props) => inSlot(false, createElement(Component, props))
      slotted.set(component, wrapped)
    }
    return wrapped
  })
}
