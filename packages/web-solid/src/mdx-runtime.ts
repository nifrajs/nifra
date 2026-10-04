/**
 * Solid MDX runtime - the `useMDXComponents` provider that `@nifrajs/web-solid/mdx`'s compiled MDX imports
 * (via `@mdx-js`'s `providerImportSource`). MDX emits intrinsic elements (`h1`, `p`, …) as *string*
 * component references, but Solid can't `createComponent("h1")` - its JSX is compile-time. So we map
 * each Markdown-output tag to a Solid component that renders it via `<Dynamic component={tag}>`.
 */
import { createComponent, type JSX, mergeProps } from "solid-js"
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

const components: Record<string, (props: Record<string, unknown>) => JSX.Element> = {}
for (const tag of MARKDOWN_TAGS) {
  // The tag merges last, so a `component` prop in the content cannot swap the element, and
  // `mergeProps` keeps Solid's prop getters live where a plain copy would read them once.
  components[tag] = (props) => createComponent(Dynamic, mergeProps(props, { component: tag }))
}

/** Returns the intrinsic-element → Solid-component map MDX content uses. Merge in your own overrides by
 * passing `components` to the MDX content component (they take precedence). */
export function useMDXComponents(): Record<
  string,
  (props: Record<string, unknown>) => JSX.Element
> {
  return components
}
