/**
 * `@nifrajs/web-solid/content` - render pre-rendered HTML (e.g. a `@nifrajs/content` collection entry's
 * `.html`) into the DOM. Solid sets `innerHTML` reactively on a `dynamic()` element. Pairs with content
 * collections: `<Content html={trustHtml(entry.html)} />`, with `trustHtml` from `@nifrajs/web`. No JSX (`createComponent`/`dynamic`), so it builds with
 * plain `tsc`.
 *
 * Security: injects raw HTML, so `html` MUST be trusted (your own Markdown/content, rendered at
 * build/server time) - never pass user-supplied HTML without sanitizing it first.
 */

import type { TrustedHtml } from "@nifrajs/web"
import { dynamic, type JSX } from "@solidjs/web"
import { createComponent, merge, omit } from "solid-js"

export interface ContentProps {
  /** Trusted, pre-rendered HTML (e.g. `entry.html`). */
  readonly html: TrustedHtml
  /** Wrapper element (default `"div"`). */
  readonly as?: string
  /** DOM passthrough (`class`, `style`, `id`, `data-*`, handlers). */
  readonly [key: string]: unknown
}

/** Render trusted HTML into a wrapper element. Extra props pass through reactively. */
export function Content(props: ContentProps): JSX.Element {
  const rest = omit(props, "html", "as")
  // The source keeps the wrapper reactive; a function source keeps `innerHTML` reactive too (matches `<Image>`).
  const Wrapper = dynamic(() => props.as ?? "div")
  return createComponent(
    Wrapper,
    merge(rest, () => ({ innerHTML: props.html })),
  )
}
