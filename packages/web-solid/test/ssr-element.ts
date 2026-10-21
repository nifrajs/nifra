import type { JSX } from "solid-js"
import { ssrElement } from "solid-js/web"

/** What Solid's compiler emits for server JSX, which its JSX types as an element. */
export const element = (tag: string, props: Record<string, unknown>, text?: string): JSX.Element =>
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: ssrElement's `{ t }` node is the server's JSX.Element, which Solid's types describe for the browser.
  ssrElement(tag, props, text, true) as unknown as JSX.Element
