/**
 * `@nifrajs/web-react/content` — render pre-rendered HTML (e.g. a `@nifrajs/content` collection entry's
 * `.html`, or any Markdown→HTML string) into the DOM via `dangerouslySetInnerHTML`. Pairs with content
 * collections: `<Content html={entry.html} />`.
 *
 * Security: this injects raw HTML, so the `html` MUST be trusted (your own Markdown/content, rendered
 * at build/server time) — never pass user-supplied HTML without sanitizing it first.
 */
import {
  type ComponentPropsWithoutRef,
  createElement,
  type ElementType,
  type ReactElement,
} from "react"

export interface ContentProps
  extends Omit<ComponentPropsWithoutRef<"div">, "dangerouslySetInnerHTML" | "children"> {
  /** Trusted, pre-rendered HTML (e.g. `entry.html`). */
  readonly html: string
  /** Wrapper element (default `"div"`). */
  readonly as?: ElementType
}

/** Render trusted HTML into a wrapper element. Extra props (`className`, `id`, `style`, …) pass through. */
export function Content({ html, as, ...rest }: ContentProps): ReactElement {
  return createElement(as ?? "div", { ...rest, dangerouslySetInnerHTML: { __html: html } })
}
