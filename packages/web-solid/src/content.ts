/**
 * `@nifrajs/web-solid/content` — render pre-rendered HTML (e.g. a `@nifrajs/content` collection entry's
 * `.html`) into the DOM. Solid sets `innerHTML` reactively on a `<Dynamic>` element. Pairs with content
 * collections: `<Content html={entry.html} />`. No JSX (`createComponent`/`Dynamic`), so it builds with
 * plain `tsc`.
 *
 * Security: injects raw HTML, so `html` MUST be trusted (your own Markdown/content, rendered at
 * build/server time) — never pass user-supplied HTML without sanitizing it first.
 */
import { createComponent, type JSX, mergeProps, splitProps } from "solid-js"
import { Dynamic } from "solid-js/web"

export interface ContentProps {
  /** Trusted, pre-rendered HTML (e.g. `entry.html`). */
  readonly html: string
  /** Wrapper element (default `"div"`). */
  readonly as?: string
  /** DOM passthrough (`class`, `style`, `id`, `data-*`, handlers). */
  readonly [key: string]: unknown
}

/** Render trusted HTML into a wrapper element. Extra props pass through reactively. */
export function Content(props: ContentProps): JSX.Element {
  const [, rest] = splitProps(props, ["html", "as"])
  // A function source keeps `component`/`innerHTML` reactive (matches the `<Image>` pattern).
  return createComponent(
    Dynamic,
    mergeProps(rest, () => ({ component: props.as ?? "div", innerHTML: props.html })),
  )
}
