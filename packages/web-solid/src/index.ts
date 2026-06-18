/**
 * @nifrajs/web-solid — the Solid render adapter for @nifrajs/web (server side) + the Solid Babel
 * Bun-plugin. Streaming SSR via `renderToStream` + `generateHydrationScript`; the layout-chain
 * fold is in `./compose`. Client hydration lives in `@nifrajs/web-solid/client` (Solid's browser
 * build).
 */
import { transformAsync } from "@babel/core"
// @ts-expect-error — no type declarations published
import presetTypeScript from "@babel/preset-typescript"
import type { RenderAdapter } from "@nifrajs/web"
// @ts-expect-error — no type declarations published
import presetSolid from "babel-preset-solid"
import type { BunPlugin } from "bun"
import {
  generateHydrationScript,
  renderToStream as solidRenderToStream,
  renderToString as solidRenderToString,
} from "solid-js/web"
import { compose } from "./compose.ts"

const HYDRATION_HEAD = generateHydrationScript()

/** The Solid server render adapter — pass to @nifrajs/web's `renderPage`. */
export const solidAdapter: RenderAdapter = {
  // Synchronous one-pass render for non-deferred pages (renderPage's buffered fast path). Solid's
  // `renderToString` emits the same hydratable markup (same `data-hk` keys seeded by
  // `generateHydrationScript()`) as `renderToStream`, but skips the TransformStream + Solid's
  // streaming machinery — the heaviest of the five renderers on Bun. A page that defer()s/Suspends
  // takes `renderToStream` below (progressive resolution needs it).
  renderToString(chain, props) {
    return solidRenderToString(compose(chain, props))
  },
  renderToStream(chain, props) {
    // Solid's `renderToStream` streams `Uint8Array` chunks into a Web `WritableStream` via
    // `pipeTo` (fire-and-forget — returns void); pipe into a TransformStream and hand back the
    // readable side. Suspense boundaries stream as they resolve; `generateHydrationScript()` (in
    // <head>) seeds client hydration. A render failure errors `ts.readable`, which `renderPage`
    // surfaces on the response body.
    const ts = new TransformStream<Uint8Array, Uint8Array>()
    solidRenderToStream(compose(chain, props)).pipeTo(ts.writable)
    return ts.readable
  },
  hydrationHead() {
    return HYDRATION_HEAD
  },
}

/**
 * Bun build/runtime plugin that compiles Solid components with Babel — `generate: "ssr"`
 * for the server, `"dom"` for the client, `hydratable` so SSR and hydrate align. Solid's
 * reactive-JSX compiler ships only as a Babel plugin (no swc/native port); this runs at
 * build time, on `.tsx` files only.
 */
export function solidBunPlugin(generate: "dom" | "ssr"): BunPlugin {
  return {
    name: `nifra-solid-${generate}`,
    setup(build) {
      // Match `.tsx`, tolerating a `?query` suffix (dev servers append one to bust Bun's import
      // cache); strip it before reading the file off disk.
      build.onLoad({ filter: /\.tsx(\?|$)/ }, async (args) => {
        const path = args.path.split("?")[0] ?? args.path
        const source = await Bun.file(path).text()
        const result = await transformAsync(source, {
          filename: path,
          // babel applies presets last→first: strip TS first, then Solid transforms JSX.
          presets: [
            [presetSolid, { generate, hydratable: true }],
            [presetTypeScript, { onlyRemoveTypeImports: true }],
          ],
        })
        return { contents: result?.code ?? "", loader: "js" }
      })
    },
  }
}
