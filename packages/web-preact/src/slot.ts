/**
 * The two wrappers a kept page renders inside, shared by the server render and the keep-alive mount so
 * the markup a document carries is the markup the browser hydrates. The inner wrapper is the element
 * taken out of the document while the page is hidden. Each is a `<slot>`, which browsers lay out as
 * `display: contents` with no inline style a CSP could block.
 */
import { type ComponentChildren, type FunctionComponent, h, type Ref } from "preact"

/** `content` inside the slot wrappers. */
export function inSlot(
  content: ComponentChildren,
  entryRef?: Ref<HTMLSlotElement>,
  pageRef?: Ref<HTMLSlotElement>,
): ComponentChildren {
  return h(
    "slot",
    { "data-nifra-entry": "", ref: entryRef },
    h("slot", { "data-nifra-page": "", ref: pageRef }, content),
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
