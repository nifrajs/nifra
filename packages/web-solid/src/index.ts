/**
 * @nifrajs/web-solid - the Solid render adapter for @nifrajs/web (server side). Streaming SSR via
 * `renderToStream` + `generateHydrationScript`; the layout-chain fold is in `./compose`. Client
 * hydration lives in `@nifrajs/web-solid/client` (Solid's browser build), and the Solid Babel
 * Bun-plugin in `@nifrajs/web-solid/plugin`.
 */
import type { RenderAdapter } from "@nifrajs/web"
import {
  generateHydrationScript,
  renderToStream as solidRenderToStream,
  renderToString as solidRenderToString,
} from "solid-js/web"
import { compose } from "./compose.ts"

const HYDRATION_HEAD = generateHydrationScript()

/** The Solid server render adapter - pass to @nifrajs/web's `renderPage`. */
export const solidAdapter: RenderAdapter = {
  // Synchronous one-pass render for non-deferred pages (renderPage's buffered fast path). Solid's
  // `renderToString` emits the same hydratable markup (same `data-hk` keys seeded by
  // `generateHydrationScript()`) as `renderToStream`, but skips the TransformStream + Solid's
  // streaming machinery - the heaviest of the five renderers on Bun. A page that defer()s/Suspends
  // takes `renderToStream` below (progressive resolution needs it).
  renderToString(chain, props) {
    return solidRenderToString(compose(chain, props))
  },
  renderToStream(chain, props, options) {
    // Solid's `renderToStream` streams `Uint8Array` chunks into a Web `WritableStream` via
    // `pipeTo` (fire-and-forget - returns void); pipe into a TransformStream and hand back the
    // readable side. Suspense boundaries stream as they resolve; `generateHydrationScript()` (in
    // <head>) seeds client hydration. A render failure errors `ts.readable`, which `renderPage`
    // surfaces on the response body. The nonce reaches the resource and boundary scripts Solid streams.
    const ts = new TransformStream<Uint8Array, Uint8Array>()
    const app = compose(chain, props)
    const stream =
      options?.nonce === undefined
        ? solidRenderToStream(app)
        : solidRenderToStream(app, { nonce: options.nonce })
    stream.pipeTo(ts.writable)
    return ts.readable
  },
  hydrationHead() {
    return HYDRATION_HEAD
  },
}
