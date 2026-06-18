import type { BunPlugin } from "bun"
import { compile } from "svelte/compiler"

/**
 * `@nifrajs/web-svelte/plugin` — the `.svelte` compiler Bun-plugin, in its OWN module (no `.svelte`
 * imports). This matters for the SSR preload: `bun --preload` must register the plugin BEFORE any
 * `.svelte` file is loaded. Importing it from the package root (`./index`) would eagerly load
 * `Chain.svelte` (the adapter's fold) before the plugin is registered — so it lives here instead.
 *
 * `generate: "server"` for SSR, `"client"` for the browser (Svelte 5's client output is hydratable).
 * Preload it for SSR (`bun --preload`) and pass it to `buildClient({ plugins: [...] })` for the client
 * bundle. The compiler runs at build time, on `.svelte` files only.
 *
 * `<style>` blocks: Svelte scopes selectors (`.foo.svelte-<hash>`) and bakes the matching classes into
 * the markup (both client + server output), so SSR HTML is already scoped. The **client** build emits
 * the scoped stylesheet as a virtual `?svelte-css` module that `Bun.build`'s CSS bundler folds into the
 * app stylesheet (served as a `<link>`); the SSR build drops it (the stylesheet ships from the client
 * build — no double-emit). With `nifra dev`, `@sveltejs/vite-plugin-svelte` injects the CSS instead.
 */
const STYLE_SUFFIX = "?svelte-css"
const STYLE_NS = "nifra-svelte-css"

export function svelteBunPlugin(generate: "dom" | "ssr"): BunPlugin {
  // Compiled scoped CSS per `.svelte` file (client build only) — read back by the virtual-module loader.
  const cssByPath = new Map<string, string>()
  return {
    name: `nifra-svelte-${generate}`,
    setup(build) {
      // Match `.svelte`, tolerating a `?query` suffix (dev servers append one to bust Bun's import
      // cache); strip it before reading the file off disk.
      build.onLoad({ filter: /\.svelte(\?|$)/ }, async (args) => {
        const path = args.path.split("?")[0] ?? args.path
        const source = await Bun.file(path).text()
        const { js, css } = compile(source, {
          generate: generate === "ssr" ? "server" : "client",
          filename: path,
          css: "external", // emit the scoped stylesheet separately (not injected into the JS)
        })
        if (generate === "dom" && css?.code) {
          cssByPath.set(path, css.code)
          // Import the virtual style module so the bundler pulls the scoped CSS into the app stylesheet.
          return {
            contents: `${js.code}\nimport ${JSON.stringify(path + STYLE_SUFFIX)}\n`,
            loader: "js",
          }
        }
        return { contents: js.code, loader: "js" }
      })
      // Virtual CSS module: `<file>.svelte?svelte-css` → the compiled scoped stylesheet (css loader).
      build.onResolve({ filter: /\?svelte-css$/ }, (args) => ({
        path: args.path,
        namespace: STYLE_NS,
      }))
      build.onLoad({ filter: /.*/, namespace: STYLE_NS }, (args) => ({
        contents: cssByPath.get(args.path.slice(0, -STYLE_SUFFIX.length)) ?? "",
        loader: "css",
      }))
    },
  }
}
