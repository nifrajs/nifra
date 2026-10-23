/**
 * The two wrappers a kept page renders inside, shared by the server render and the keep-alive mount so
 * the markup a document carries is the markup the browser hydrates. The inner wrapper is the element
 * taken out of the document while the page is hidden.
 */
import { type ComponentChildren, type FunctionComponent, h, type Ref } from "preact"

const CONTENTS = { display: "contents" } as const

/** `content` inside the slot wrappers. */
export function inSlot(
  content: ComponentChildren,
  entryRef?: Ref<HTMLDivElement>,
  pageRef?: Ref<HTMLDivElement>,
): ComponentChildren {
  return h(
    "div",
    { "data-nifra-entry": "", style: CONTENTS, ref: entryRef },
    h("div", { "data-nifra-page": "", style: CONTENTS, ref: pageRef }, content),
  )
}

const slotted = new WeakMap<object, FunctionComponent<Record<string, unknown>>>()

/** `chain` with the entries at `slots` rendered inside the slot wrappers (the server's half). */
export function slottedChain(chain: readonly unknown[], slots: readonly number[]): unknown[] {
  return chain.map((component, depth) => {
    if (
      !slots.includes(depth) ||
      (typeof component !== "function" && typeof component !== "object") ||
      component === null
    )
      return component
    let wrapped = slotted.get(component)
    if (wrapped === undefined) {
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a chain entry is a route or layout module's default export, a component
      const Component = component as FunctionComponent<Record<string, unknown>>
      wrapped = (props) => inSlot(h(Component, props))
      slotted.set(component, wrapped)
    }
    return wrapped
  })
}
