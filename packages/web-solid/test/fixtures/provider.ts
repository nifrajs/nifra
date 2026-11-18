import { createRenderEffect } from "solid-js"

/**
 * A context provider returns a lazy memo that disposes when nothing observes it, so a test that wants the
 * children it sets up observes the result, as a render does.
 */
export function observe(view: unknown): void {
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a provider component returns the accessor Solid renders; its JSX.Element type leaves functions out.
  createRenderEffect(view as () => unknown, () => {})
}
