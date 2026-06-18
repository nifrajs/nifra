/**
 * Solid MDX runtime — the `useMDXComponents` provider that `@nifrajs/web-solid/mdx`'s compiled MDX imports
 * (via `@mdx-js`'s `providerImportSource`). MDX emits intrinsic elements (`h1`, `p`, …) as *string*
 * component references, but Solid can't `createComponent("h1")` — its JSX is compile-time. So we map
 * each Markdown-output tag to a Solid component that renders it via `<Dynamic component={tag}>`.
 */
import { createComponent } from "solid-js"
import { Dynamic } from "solid-js/web"

// The HTML element set CommonMark + GFM produce. An explicit map (not a Proxy): `@mdx-js` *spreads* the
// provider's result into a plain object, so only own-enumerable keys survive.
const MARKDOWN_TAGS = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "img",
  "input",
  "li",
  "ol",
  "p",
  "pre",
  "section",
  "span",
  "strong",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
] as const

const components: Record<string, (props: Record<string, unknown>) => unknown> = {}
for (const tag of MARKDOWN_TAGS) {
  components[tag] = (props) => createComponent(Dynamic, Object.assign({ component: tag }, props))
}

/** Returns the intrinsic-element → Solid-component map MDX content uses. Merge in your own overrides by
 * passing `components` to the MDX content component (they take precedence). */
export function useMDXComponents(): Record<string, (props: Record<string, unknown>) => unknown> {
  return components
}
