/**
 * `@nifrajs/web-solid/plugin` - the Solid Babel Bun plugin, in its OWN module so the adapter root (which
 * every Solid SSR server and edge worker bundles) never links build-time code. Mirrors
 * `@nifrajs/web-vue/plugin`: pass `"dom"` for the client bundle and `"ssr"` for the server.
 */
import { transformAsync } from "@babel/core"
// @ts-expect-error - no type declarations published
import presetTypeScript from "@babel/preset-typescript"
import { devServerCompile, normalizeFilePath, rewriteSsrImports } from "@nifrajs/web/plugins/kit"
// @ts-expect-error - no type declarations published
import presetSolid from "babel-preset-solid"
import type { BunPlugin } from "bun"
import solidRefreshBunHot, { SOLID_HOT_MODULE } from "./refresh-babel.ts"

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
        const path = normalizeFilePath(args.path)
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
 * The Babel half loads lazily: it is dev-only, and every production build loads this plugin too.
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
