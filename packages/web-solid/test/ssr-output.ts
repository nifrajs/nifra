import type { JSX } from "@solidjs/web"
import { ssrElement } from "@solidjs/web"

/** What Solid's compiler emits for server JSX, which its JSX types as an element. */
export const element = (tag: string, props: Record<string, unknown>, text?: string): JSX.Element =>
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: ssrElement's `{ t }` node is the server's JSX.Element, which Solid's types describe for the browser.
  ssrElement(tag, props, text, true) as unknown as JSX.Element

/**
 * The markup a reader sees: without Solid's hydration keys (`_hk`), and without the state Solid
 * appends after it as a script.
 */
export const visible = (html: string): string => {
  const scriptAt = html.indexOf("<script>")
  return (scriptAt === -1 ? html : html.slice(0, scriptAt))
    .replace(/ _hk=[^ >]*/g, "")
    .replace(/ >/g, ">")
}
