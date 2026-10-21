import type { RenderAdapter } from "@nifrajs/web"
/**
 * @nifrajs/web-react - the React render adapter for @nifrajs/web (server side). Streaming SSR via
 * `renderToReadableStream`; the layout-chain fold is in `./compose`. Client hydration lives in
 * `@nifrajs/web-react/client`. React's JSX is Bun-native - no build plugin needed.
 */
import type { ReactNode } from "react"
import { compose } from "./compose.ts"
import { reactDomServer } from "./react-dom-server.ts"
import { explainRenderError } from "./render-error.ts"

// The marker opening a Suspense boundary the server gave up on. Markup can't forge it: React escapes
// text, and a comment only comes from React itself or `dangerouslySetInnerHTML`.
const CLIENT_RENDERED_BOUNDARY = "<!--$!-->"

// React error 426, minified in production: a component suspended with no Suspense boundary above it.
const suspendedSynchronously = (error: unknown): boolean =>
  error instanceof Error &&
  (error.message.includes("Minified React error #426;") ||
    error.message.includes("suspended while responding to synchronous input"))

/** The React server render adapter - pass to @nifrajs/web's `renderPage`. */
export const reactAdapter: RenderAdapter = {
  // Synchronous one-pass render for non-deferred pages (renderPage's buffered fast path). React's
  // `renderToString` emits the same hydration-compatible markup as the Fizz stream for non-Suspense
  // content and is markedly cheaper than `renderToReadableStream` - most visibly on Bun, where Fizz's
  // streaming machinery is the heaviest. A page that defer()s/Suspends takes `renderToStream` below.
  //
  // Async because the `react-dom/server` module is resolved lazily (from the consumer app's node_modules
  // under Bun runtime SSR - see ./react-dom-server). `RenderAdapter.renderToString` permits a Promise;
  // renderPage awaits it.
  //
  // React's string renderer cannot wait for a component that suspends (`use`, `lazy`): it writes the
  // boundary's fallback behind a client-render marker, or throws with no boundary above it. Either
  // way the page is handed back (`undefined`) to be streamed, where the boundary resolves.
  async renderToString(chain, props) {
    const { renderToString } = await reactDomServer()
    let html: string
    try {
      html = renderToString(compose(chain, props))
    } catch (error) {
      if (suspendedSynchronously(error)) return undefined
      throw explainRenderError(error)
    }
    return html.includes(CLIENT_RENDERED_BOUNDARY) ? undefined : html
  },
  // A partially prerendered hole's HTML: rendered alone, its `useId`s prefixed so they never collide
  // with the page's, which the client root it hydrates into repeats.
  async renderFragment(ui, options) {
    const { renderToString } = await reactDomServer()
    try {
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a hole's render returns React output; the seam erases it to unknown.
      return renderToString(ui() as ReactNode, { identifierPrefix: options.idPrefix ?? "" })
    } catch (error) {
      throw explainRenderError(error)
    }
  },
  async renderToStream(chain, props, options) {
    // Resolves a Web `ReadableStream<Uint8Array>` once the shell is renderable; Suspense
    // boundaries stream as they resolve. No `bootstrapModules` - nifra injects the client entry in
    // the document tail. React's default `onError` logs to console.error (errors aren't swallowed).
    // The nonce reaches the inline runtime React streams to reveal each resolved boundary.
    const { renderToReadableStream } = await reactDomServer()
    try {
      return await (options?.nonce === undefined
        ? renderToReadableStream(compose(chain, props))
        : renderToReadableStream(compose(chain, props), { nonce: options.nonce }))
    } catch (error) {
      throw explainRenderError(error)
    }
  },
  // React reconciles against the existing DOM on hydrate, so no per-document bootstrap
  // script is needed (contrast Solid's generateHydrationScript) - the seam allows both.
  hydrationHead() {
    return ""
  },
}
