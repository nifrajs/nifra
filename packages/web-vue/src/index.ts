import type { RenderAdapter } from "@nifrajs/web"
/**
 * @nifrajs/web-vue — the Vue render adapter for @nifrajs/web (server side). Streaming SSR via Vue's
 * `renderToWebStream` (a Web `ReadableStream<Uint8Array>`, the seam's native shape); the layout-chain
 * fold is in `./compose`. Client hydration lives in `@nifrajs/web-vue/client`. Uses Vue render functions
 * (`h`), so no SFC compiler / build plugin is needed (contrast `@nifrajs/web-solid`).
 */
import { createSSRApp, defineComponent } from "vue"
import { renderToWebStream, renderToString as vueRenderToString } from "vue/server-renderer"
import { compose } from "./compose.ts"

/** A root SSR app component that renders the composed layout chain. */
const rootApp = (
  chain: readonly unknown[],
  props: Parameters<RenderAdapter["renderToStream"]>[1],
) => createSSRApp(defineComponent({ setup: () => () => compose(chain, props) }))

/** The Vue server render adapter — pass to @nifrajs/web's `renderPage`. */
export const vueAdapter: RenderAdapter = {
  // Synchronous (well, awaited) one-pass render for non-deferred pages (renderPage's buffered fast
  // path). Vue's `renderToString` resolves the same markup as `renderToWebStream` without the stream.
  renderToString(chain, props) {
    return vueRenderToString(rootApp(chain, props))
  },
  renderToStream(chain, props) {
    // A root component renders the composed chain; createSSRApp + renderToWebStream stream it as a
    // Web ReadableStream (Suspense boundaries stream as they resolve).
    return renderToWebStream(rootApp(chain, props))
  },
  // Vue hydrates by reconciling against the existing DOM (createSSRApp on the client), so there's
  // no per-document bootstrap script — like React. The seam allows the empty string.
  hydrationHead() {
    return ""
  },
}
