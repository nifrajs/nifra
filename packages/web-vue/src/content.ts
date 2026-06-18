/**
 * `@nifrajs/web-vue/content` — render pre-rendered HTML (e.g. a `@nifrajs/content` collection entry's
 * `.html`) into the DOM via Vue's `innerHTML`. Pairs with content collections:
 * `<Content :html="entry.html" />`.
 *
 * Security: injects raw HTML, so `html` MUST be trusted (your own Markdown/content, rendered at
 * build/server time) — never pass user-supplied HTML without sanitizing it first.
 */
import { defineComponent, h } from "vue"

/** Render trusted HTML into a wrapper element. `inheritAttrs: false` + manual attr spread so passthrough
 * (`class`, `id`, `style`, …) lands on the wrapper exactly once. */
export const Content = defineComponent({
  name: "NifraContent",
  inheritAttrs: false,
  props: {
    /** Trusted, pre-rendered HTML (e.g. `entry.html`). */
    html: { type: String, required: true },
    /** Wrapper element (default `"div"`). */
    as: { type: String, default: "div" },
  },
  setup(props, { attrs }) {
    return () => h(props.as, { ...attrs, innerHTML: props.html })
  },
})
