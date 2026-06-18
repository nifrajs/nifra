/**
 * `@nifrajs/web-preact/content` — render pre-rendered HTML (e.g. a `@nifrajs/content` collection entry's
 * `.html`) into the DOM via `dangerouslySetInnerHTML`. Pairs with content collections:
 * `<Content html={entry.html} />`.
 *
 * Security: injects raw HTML, so `html` MUST be trusted (your own Markdown/content, rendered at
 * build/server time) — never pass user-supplied HTML without sanitizing it first.
 */
import { createElement, type JSX, type VNode } from "preact"

export interface ContentProps
  extends Omit<JSX.HTMLAttributes<HTMLElement>, "dangerouslySetInnerHTML"> {
  /** Trusted, pre-rendered HTML (e.g. `entry.html`). */
  readonly html: string
  /** Wrapper element (default `"div"`). */
  readonly as?: string
}

/** Render trusted HTML into a wrapper element. Extra props (`class`, `id`, `style`, …) pass through. */
export function Content({ html, as, ...rest }: ContentProps): VNode {
  // Typed intermediate (like `<Image>`) keeps the inferred `VNode` generic stable under
  // exactOptionalPropertyTypes (a bare object literal infers an over-specific, non-assignable VNode).
  const props: JSX.HTMLAttributes<HTMLElement> = {
    ...rest,
    dangerouslySetInnerHTML: { __html: html },
  }
  return createElement(as ?? "div", props)
}
