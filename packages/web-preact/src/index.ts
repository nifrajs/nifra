import type { RenderAdapter } from "@nifrajs/web"
/**
 * @nifrajs/web-preact - the Preact render adapter for @nifrajs/web (server side). Streaming SSR via
 * `renderToReadableStream` from `preact-render-to-string/stream` (a Web `ReadableStream<Uint8Array>`,
 * the seam's native shape); the layout-chain fold is in `./compose`. Client hydration lives in
 * `@nifrajs/web-preact/client`. Preact uses `h()` render functions, so no JSX/build plugin is needed
 * (contrast `@nifrajs/web-solid`'s Babel plugin).
 */
import { compose } from "./compose.ts"
import { preactRenderToStream, preactRenderToString } from "./preact-render.ts"

const ISLAND_RUNTIME_OPEN = "<script>(function(){"
const ISLAND_RUNTIME_OPEN_BYTES = new TextEncoder().encode(ISLAND_RUNTIME_OPEN)

const startsWithBytes = (chunk: Uint8Array, prefix: Uint8Array): boolean => {
  if (chunk.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) if (chunk[i] !== prefix[i]) return false
  return true
}

/**
 * `preact-render-to-string` streams the runtime that moves resolved `<Suspense>` content into place as
 * one attribute-less `<script>` chunk, and takes no nonce option. Stamp the document nonce on exactly
 * that chunk (it defines the `preact-island` element); every other chunk passes through untouched, so
 * an app-rendered `<script>` never inherits the nonce.
 */
function withIslandRuntimeNonce(
  stream: ReadableStream<Uint8Array>,
  nonce: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const nonced = `<script nonce="${nonce.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}">(function(){`
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (startsWithBytes(chunk, ISLAND_RUNTIME_OPEN_BYTES)) {
          const text = decoder.decode(chunk)
          if (text.includes('"preact-island"')) {
            controller.enqueue(encoder.encode(nonced + text.slice(ISLAND_RUNTIME_OPEN.length)))
            return
          }
        }
        controller.enqueue(chunk)
      },
    }),
  )
}

/** The Preact server render adapter - pass to @nifrajs/web's `renderPage`. */
export const preactAdapter: RenderAdapter = {
  // Synchronous one-pass render for non-deferred pages (renderPage's buffered fast path). The sync
  // `renderToString` emits the same markup as the stream renderer without the chunking machinery.
  //
  // The first render resolves the renderer lazily (from the consumer app's node_modules under Bun
  // runtime SSR - see ./preact-render). Once loaded, return the string directly so renderPage can use
  // its synchronous buffered fast path on every subsequent request.
  renderToString(chain, props) {
    const loaded = preactRenderToString()
    if (loaded instanceof Promise) {
      return loaded.then(({ renderToString }) => renderToString(compose(chain, props)))
    }
    return loaded.renderToString(compose(chain, props))
  },
  async renderToStream(chain, props, options) {
    // `renderToReadableStream` yields a Web ReadableStream<Uint8Array>; <Suspense> boundaries
    // (preact/compat) stream as they resolve, mirroring the React adapter.
    const { renderToReadableStream } = await preactRenderToStream()
    const stream = renderToReadableStream(compose(chain, props))
    return options?.nonce === undefined ? stream : withIslandRuntimeNonce(stream, options.nonce)
  },
  // Preact reconciles against the existing DOM on hydrate (like React), so there's no per-document
  // bootstrap script - the seam allows the empty string (contrast Solid's generateHydrationScript).
  hydrationHead() {
    return ""
  },
}
