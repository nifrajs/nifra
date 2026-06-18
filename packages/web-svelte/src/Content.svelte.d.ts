import type { Component } from "svelte"

/**
 * Hand-written types for `Content.svelte` (svelte-package would generate this). Consumers resolve this
 * through the `./content` export's `types` condition.
 */
export interface ContentProps {
  /** Trusted, pre-rendered HTML (e.g. `entry.html`). */
  html: string
  /** Wrapper element (default `"div"`). */
  as?: string
  /** DOM passthrough (`class`, `style`, `id`, `data-*`, …). */
  [key: string]: unknown
}

declare const Content: Component<ContentProps>
export default Content
