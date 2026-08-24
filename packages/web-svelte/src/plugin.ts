import {
  devHotComponent,
  devServerCompile,
  normalizeFilePath,
  portablePath,
  rewriteSsrImports,
} from "@nifrajs/web/plugins/kit"
import type { BunPlugin } from "bun"
import { compile } from "svelte/compiler"

/**
 * `@nifrajs/web-svelte/plugin` - the `.svelte` compiler Bun-plugin, in its OWN module (no `.svelte`
 * imports). This matters for the SSR preload: `bun --preload` must register the plugin BEFORE any
 * `.svelte` file is loaded. Importing it from the package root (`./index`) would eagerly load
 * `Chain.svelte` (the adapter's fold) before the plugin is registered - so it lives here instead.
 *
 * `generate: "server"` for SSR, `"client"` for the browser (Svelte 5's client output is hydratable).
 * Preload it for SSR (`bun --preload`) and pass it to `buildClient({ plugins: [...] })` for the client
 * bundle. The compiler runs at build time, on `.svelte` files only.
 *
 * `<style>` blocks: Svelte scopes selectors (`.foo.svelte-<hash>`) and bakes the matching classes into
 * the markup (both client + server output), so SSR HTML is already scoped. The **client** build emits
 * the scoped stylesheet as a virtual `?svelte-css` module that `Bun.build`'s CSS bundler folds into the
 * app stylesheet (served as a `<link>`); the SSR build drops it (the stylesheet ships from the client
 * build - no double-emit). With `nifra dev`, `@sveltejs/vite-plugin-svelte` injects the CSS instead.
 */
const STYLE_SUFFIX = "?svelte-css"
const STYLE_NS = "nifra-svelte-css"

/**
 * The same hot-patch boundary as the Bun pipeline's, in the shape `@sveltejs/vite-plugin-svelte` takes:
 *
 * ```ts
 * svelte({ dynamicCompileOptions: svelteHmrBoundary })
 * ```
 *
 * Svelte's HMR wrapper resolves the component through a signal, which survives hydration only where
 * the component is a plain child in a template. A layout or a page is not: the adapter's `Chain` enters
 * chain members as dynamic components and through snippets, so a wrapper on one leaves the hydration
 * cursor pointing at markup the wrapped component never claims. Svelte then throws the server's tree
 * away and re-renders on the client - `hydration_mismatch` in the console, on first load, before any
 * edit. Left on, the dev server quietly stops exercising hydration at all.
 *
 * Views keep hot-patching; route modules fall back to a full reload, which is what they want anyway
 * (a route module carries the loader and meta the server ran, and re-running those is a navigation).
 * Outside a nifra dev server nothing is announced and the answer is "no boundary" - a full reload is
 * always correct, a mispatched tree is not.
 */
export function svelteHmrBoundary({ filename }: { filename: string }): { hmr: boolean } {
  return { hmr: devHotComponent(filename) }
}

export function svelteBunPlugin(generate: "dom" | "ssr"): BunPlugin {
  // Compiled scoped CSS per `.svelte` file (client build only) - read back by the virtual-module loader.
  const cssByPath = new Map<string, string>()
  return {
    name: `nifra-svelte-${generate}`,
    setup(build) {
      // Match `.svelte`, tolerating a `?query` suffix (dev servers append one to bust Bun's import
      // cache); strip it before reading the file off disk.
      build.onLoad({ filter: /\.svelte(\?|$)/ }, async (args) => {
        const path = normalizeFilePath(args.path)
        const source = await Bun.file(path).text()
        // Per compile, not per registration: the CLI registers the SSR plugin before the dev server
        // exists, and the flag is set by the dev server.
        //
        // Svelte's HMR is a compiler feature (`$.hmr` + a self-accepting `import.meta.hot.accept`), and
        // it is only available under `dev`. `dev` is set on BOTH halves so the server and client builds
        // stay the same Svelte, while `hmr` stays client-only, there being no `import.meta.hot` on the
        // server. `nifra build` sets neither, so nothing here reaches a production bundle.
        //
        // The server half additionally needs Svelte's own runtime in its dev shape - `dev` output calls
        // `push_element`, which reads state the runtime only records when ITS `DEV` is true. That flag
        // resolves through `esm-env`, which falls back to `NODE_ENV` off the export conditions; the dev
        // server sets it for exactly this reason. Getting that half wrong throws on the first element:
        // `undefined is not an object (evaluating 'context.function[FILENAME]')`.
        //
        // `hmr` narrows further, to the app's own non-route components ({@link devHotComponent}).
        // Svelte's wrapper replaces the component with a block that resolves it through a signal, and
        // that survives hydration only where the component is a plain child in a template. A chain
        // member is not: the adapter's `Chain` enters layouts and pages as dynamic components and
        // through snippets, and a wrapper on either side of that leaves the hydration cursor pointing
        // at markup the wrapped component never claims - the whole tree is then thrown away and
        // re-rendered on the client, silently, before any edit. A view component is the boundary that
        // works, and it is also the one worth patching.
        const dev = devServerCompile()
        const { js, css } = compile(source, {
          generate: generate === "ssr" ? "server" : "client",
          filename: path,
          css: "external", // emit the scoped stylesheet separately (not injected into the JS)
          dev,
          hmr: dev && generate === "dom" && devHotComponent(path),
        })
        if (generate === "dom" && css?.code) {
          cssByPath.set(portablePath(path), css.code)
          // Import the virtual style module so the bundler pulls the scoped CSS into the app stylesheet.
          return {
            contents: `${js.code}\nimport ${JSON.stringify(portablePath(path) + STYLE_SUFFIX)}\n`,
            loader: "js",
          }
        }
        return { contents: rewriteSsrImports(js.code, path, generate), loader: "js" }
      })
      // Virtual CSS module: `<file>.svelte?svelte-css` → the compiled scoped stylesheet (css loader).
      build.onResolve({ filter: /\?svelte-css$/ }, (args) => ({
        path: args.path,
        namespace: STYLE_NS,
      }))
      build.onLoad({ filter: /.*/, namespace: STYLE_NS }, (args) => ({
        contents: cssByPath.get(portablePath(args.path.slice(0, -STYLE_SUFFIX.length))) ?? "",
        loader: "css",
      }))
    },
  }
}
