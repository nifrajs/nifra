import type { RenderAdapter } from "@nifrajs/web"
/**
 * @nifrajs/web-preact — the Preact render adapter for @nifrajs/web (server side). Streaming SSR via
 * `renderToReadableStream` from `preact-render-to-string/stream` (a Web `ReadableStream<Uint8Array>`,
 * the seam's native shape); the layout-chain fold is in `./compose`. Client hydration lives in
 * `@nifrajs/web-preact/client`. Preact uses `h()` render functions, so no JSX/build plugin is needed
 * (contrast `@nifrajs/web-solid`'s Babel plugin).
 */
import { renderToString as preactRenderToString } from "preact-render-to-string"
import { renderToReadableStream } from "preact-render-to-string/stream"
import { compose } from "./compose.ts"

/** The Preact server render adapter — pass to @nifrajs/web's `renderPage`. */
export const preactAdapter: RenderAdapter = {
  // Synchronous one-pass render for non-deferred pages (renderPage's buffered fast path). The sync
  // `renderToString` emits the same markup as the stream renderer without the chunking machinery.
  renderToString(chain, props) {
    return preactRenderToString(compose(chain, props))
  },
  renderToStream(chain, props) {
    // `renderToReadableStream` yields a Web ReadableStream<Uint8Array>; <Suspense> boundaries
    // (preact/compat) stream as they resolve, mirroring the React adapter.
    return renderToReadableStream(compose(chain, props))
  },
  // Preact reconciles against the existing DOM on hydrate (like React), so there's no per-document
  // bootstrap script — the seam allows the empty string (contrast Solid's generateHydrationScript).
  hydrationHead() {
    return ""
  },
}
