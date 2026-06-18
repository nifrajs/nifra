/**
 * @nifrajs/web-vanilla — the zero-framework render adapter for @nifrajs/web.
 *
 * Pages are plain functions returning auto-escaping `html` tagged templates; the client ships
 * **no framework runtime at all**. Use it for content/SEO surfaces (landing pages, listings,
 * docs, comparison tables) where HTML is the product — interactivity comes from
 * `@nifrajs/web/islands` entries (`islandScripts`), each a hand-sized vanilla module.
 *
 * Routes using this adapter are server-rendered documents, not hydrated apps — set
 * `export const hydrate = false` on the route (there is no client runtime to hydrate with);
 * `renderPage` then omits the framework bootstrap entirely. Loaders, actions, ISR, SSG, head
 * management, and streaming all work unchanged — they live in @nifrajs/web, not the view layer.
 *
 *   import { html, vanillaAdapter } from "@nifrajs/web-vanilla"
 *
 *   export default function Hotels({ data }) {
 *     const { hotels } = data as { hotels: Array<{ name: string; pricePaise: number }> }
 *     return html`<ul>${hotels.map((h) => html`<li>${h.name} — ₹${h.pricePaise / 100}</li>`)}</ul>`
 *   }
 */

import type { RenderAdapter, RenderProps } from "@nifrajs/web"
import { compose } from "./compose.ts"

export { compose, type VanillaComponent } from "./compose.ts"
export { type HtmlValue, html, RawHtml, raw, Template } from "./html.ts"

const ENCODER = new TextEncoder()

/** The zero-framework server render adapter — pass to @nifrajs/web's `renderPage`/`createWebApp`. */
export const vanillaAdapter: RenderAdapter = {
  // One-pass string render — renderPage's buffered fast path uses this for every non-deferred
  // page, which for vanilla routes is the norm.
  renderToString(chain: readonly unknown[], props: RenderProps): string {
    return compose(chain, props).html
  },
  // Deferred pages need the streaming seam; a synchronous renderer satisfies it with a one-chunk
  // stream (the shell IS the document — vanilla has no Suspense boundaries of its own; @nifrajs/web's
  // defer()/<no-js fallback> machinery handles progressive data above this seam).
  renderToStream(chain: readonly unknown[], props: RenderProps): ReadableStream<Uint8Array> {
    const body = compose(chain, props).html
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(ENCODER.encode(body))
        controller.close()
      },
    })
  },
  // No client runtime ⇒ no per-document bootstrap markup.
  hydrationHead(): string {
    return ""
  },
}
