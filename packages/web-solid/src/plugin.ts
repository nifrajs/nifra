/**
 * `@nifrajs/web-solid/plugin` - the Solid compiler Bun plugin, in its OWN module so the adapter root (which
 * every Solid SSR server and edge worker bundles) never links build-time code. Mirrors
 * `@nifrajs/web-vue/plugin`: pass `"dom"` for the client bundle and `"ssr"` for the server.
 */
import {
  devServerCompile,
  normalizeFilePath,
  readSource,
  rewriteSsrImports,
} from "@nifrajs/web/plugins/kit"
import { transformAsync, transformRefreshAsync } from "@solidjs/compiler"
import type { BunPlugin } from "bun"
import { rewriteRefreshCall, SOLID_HOT_MODULE } from "./refresh-rewrite.ts"

/**
 * Bun build/runtime plugin that compiles Solid components with Solid 2.0's native compiler -
 * `generate: "ssr"` for the server, `"dom"` for the client, `hydratable` so SSR and hydrate align. Runs
 * at build time, on `.tsx` files only. The compiler parses TypeScript but keeps its types, so Bun's own
 * `ts` loader strips them after the JSX is gone.
 *
 * Under a dev server the client half additionally runs the compiler's refresh pass, which is what makes
 * an edit patch the running component tree instead of reloading the page - see {@link setupSolidRefresh}.
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
        const source = await readSource(build, path)
        const compiled = await transformAsync(source, {
          filename: path,
          generate,
          hydratable: true,
        })
        const code =
          refresh === undefined
            ? compiled.code
            : rewriteRefreshCall(
                (
                  await transformRefreshAsync(compiled.code, {
                    filename: path,
                    bundler: "vite",
                    jsx: false,
                    importSource: "solid-js/refresh",
                  })
                ).code,
              )
        return { contents: rewriteSsrImports(code, path, generate), loader: "ts" }
      })
    },
  }
}

/**
 * Wire the refresh runtime into a dev-server client compile.
 *
 * Solid components are compiled reactive closures, not functions re-run on render, so a new module
 * version cannot simply replace the old one - the refresh pass wraps every component in a registry and, on
 * an update, patches the live instances, keeping signal state. Without it the update finds no accepting
 * module, bubbles up to the generated entry, and Bun reloads the whole page.
 *
 * `nifra:solid-hot` is this package's own bridge module and has no app-side name at all, so it is pinned
 * here; the emitted import lands in the app's own files.
 */
function setupSolidRefresh(build: Parameters<BunPlugin["setup"]>[0]): true {
  // `.ts` from source (Bun takes the package's `bun` export condition), `.js` from the published build.
  const bridge = `${import.meta.dir}/refresh-hot${import.meta.path.endsWith(".ts") ? ".ts" : ".js"}`
  build.onResolve({ filter: new RegExp(`^${SOLID_HOT_MODULE}$`) }, () => ({ path: bridge }))
  return true
}
