/**
 * @nifrajs/web-solid - the Solid render adapter for @nifrajs/web (server side) + the Solid Babel
 * Bun-plugin. Streaming SSR via `renderToStream` + `generateHydrationScript`; the layout-chain
 * fold is in `./compose`. Client hydration lives in `@nifrajs/web-solid/client` (Solid's browser
 * build).
 */
import { transformAsync } from "@babel/core"
// @ts-expect-error - no type declarations published
import presetTypeScript from "@babel/preset-typescript"
import type { RenderAdapter } from "@nifrajs/web"
import { devServerCompile, rewriteSsrImports } from "@nifrajs/web/plugins/kit"
// @ts-expect-error - no type declarations published
import presetSolid from "babel-preset-solid"
import type { BunPlugin } from "bun"
import {
  generateHydrationScript,
  renderToStream as solidRenderToStream,
  renderToString as solidRenderToString,
} from "solid-js/web"
import { compose } from "./compose.ts"
import solidRefreshBunHot, { SOLID_HOT_MODULE } from "./refresh-babel.ts"

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
  renderToStream(chain, props) {
    // Solid's `renderToStream` streams `Uint8Array` chunks into a Web `WritableStream` via
    // `pipeTo` (fire-and-forget - returns void); pipe into a TransformStream and hand back the
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
 * Bun build/runtime plugin that compiles Solid components with Babel - `generate: "ssr"`
 * for the server, `"dom"` for the client, `hydratable` so SSR and hydrate align. Solid's
 * reactive-JSX compiler ships only as a Babel plugin (no swc/native port); this runs at
 * build time, on `.tsx` files only.
 *
 * Under a dev server the client half additionally runs `solid-refresh`, which is what makes an edit
 * patch the running component tree instead of reloading the page - see {@link setupSolidRefresh}.
 */
export function solidBunPlugin(generate: "dom" | "ssr"): BunPlugin {
  return {
    name: `nifra-solid-${generate}`,
    setup(build) {
      const refresh =
        generate === "dom" && devServerCompile() ? setupSolidRefresh(build) : undefined
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
          ...(refresh !== undefined
            ? { plugins: [[await refresh.babel(), REFRESH_OPTIONS], solidRefreshBunHot] }
            : {}),
        })
        return { contents: rewriteSsrImports(result?.code ?? "", path, generate), loader: "js" }
      })
    },
  }
}

/**
 * `"esm"` is the closest of `solid-refresh`'s bundler modes to what Bun implements: one
 * `accept(mod => …)` per module, falling back to `invalidate()` when a component's signature changed too
 * much to patch in place. `"vite"` differs only by also calling a bare `accept()` first, which would make
 * every module self-accepting twice over. The call it emits is still Vite-shaped, and
 * `solidRefreshBunHot` translates it.
 *
 * `jsx: false` turns OFF the pass that lifts a component's returned JSX into a second, nested component.
 * That extra component is an extra hydration level on the client and none on the server, so with it on,
 * every hydratable page dies on `Unable to find DOM nodes for hydration key` before a single edit. It buys
 * finer-grained patching of markup-only edits; correct hydration is worth more.
 */
const REFRESH_OPTIONS = { bundler: "esm", jsx: false } as const

/**
 * Wire `solid-refresh` into a dev-server client compile.
 *
 * Solid components are compiled reactive closures, not functions re-run on render, so a new module
 * version cannot simply replace the old one - `solid-refresh` wraps every component in a registry and, on
 * an update, patches the live instances, keeping signal state. Without it the update finds no accepting
 * module, bubbles up to the generated entry, and Bun reloads the whole page.
 *
 * The Babel half loads lazily: it is dev-only, and this module is the adapter root every Solid SSR
 * server imports.
 *
 * Both runtime specifiers need pinning, because the transform emits them INTO the app's own files, where
 * a bare specifier resolves against the app. `solid-refresh` is only a transitive dependency there and
 * need not be hoisted; `nifra:solid-hot` is this package's own bridge module and has no app-side name at
 * all. Resolving both here is what keeps the emitted imports working without an app depending on either.
 */
function setupSolidRefresh(build: Parameters<BunPlugin["setup"]>[0]): {
  babel: () => Promise<unknown>
} {
  const runtime = Bun.resolveSync("solid-refresh", import.meta.dir)
  build.onResolve({ filter: /^solid-refresh$/ }, () => ({ path: runtime }))
  // `.ts` from source (Bun takes the package's `bun` export condition), `.js` from the published build.
  const bridge = `${import.meta.dir}/refresh-hot${import.meta.path.endsWith(".ts") ? ".ts" : ".js"}`
  build.onResolve({ filter: new RegExp(`^${SOLID_HOT_MODULE}$`) }, () => ({ path: bridge }))
  let babel: Promise<unknown> | undefined
  return {
    babel: () => (babel ??= import("solid-refresh/babel").then((m) => m.default)),
  }
}
