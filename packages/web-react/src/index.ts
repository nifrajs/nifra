import type { RenderAdapter } from "@nifrajs/web"
/**
 * @nifrajs/web-react — the React render adapter for @nifrajs/web (server side). Streaming SSR via
 * `renderToReadableStream`; the layout-chain fold is in `./compose`. Client hydration lives in
 * `@nifrajs/web-react/client`. React's JSX is Bun-native — no build plugin needed.
 */
import { compose } from "./compose.ts"
import { reactDomServer } from "./react-dom-server.ts"

/** The React server render adapter — pass to @nifrajs/web's `renderPage`. */
export const reactAdapter: RenderAdapter = {
  // Synchronous one-pass render for non-deferred pages (renderPage's buffered fast path). React's
  // `renderToString` emits the same hydration-compatible markup as the Fizz stream for non-Suspense
  // content and is markedly cheaper than `renderToReadableStream` — most visibly on Bun, where Fizz's
  // streaming machinery is the heaviest. A page that defer()s/Suspends takes `renderToStream` below.
  //
  // Async because the `react-dom/server` module is resolved lazily (from the consumer app's node_modules
  // under Bun runtime SSR — see ./react-dom-server). `RenderAdapter.renderToString` permits a Promise;
  // renderPage awaits it.
  async renderToString(chain, props) {
    const { renderToString } = await reactDomServer()
    return renderToString(compose(chain, props))
  },
  async renderToStream(chain, props) {
    // Resolves a Web `ReadableStream<Uint8Array>` once the shell is renderable; Suspense
    // boundaries stream as they resolve. No `bootstrapModules` — nifra injects the client entry in
    // the document tail. React's default `onError` logs to console.error (errors aren't swallowed).
    const { renderToReadableStream } = await reactDomServer()
    return renderToReadableStream(compose(chain, props))
  },
  // React reconciles against the existing DOM on hydrate, so no per-document bootstrap
  // script is needed (contrast Solid's generateHydrationScript) — the seam allows both.
  hydrationHead() {
    return ""
  },
}
