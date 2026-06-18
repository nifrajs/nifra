import type { BunPlugin } from "bun"
import { compile } from "svelte/compiler"

/**
 * `@nifrajs/web-svelte/mdx` — compile `.mdx` routes/files to **Svelte** components. Svelte has no JSX
 * runtime, so (unlike the JSX-family `mdxBunPlugin`) MDX-for-Svelte goes through `mdsvex` — Svelte's
 * own Markdown compiler — which produces a `.svelte` module, then the standard `svelte/compiler` runs
 * (`generate: "server"` for SSR, `"client"` for the browser). Pass it to `buildClient`/`buildServer`'s
 * `plugins` alongside `svelteBunPlugin` (one handles `.svelte`, this one `.mdx`). `mdsvex` is an
 * optional peer, lazy-loaded at build time.
 *
 * `<style>` blocks inside MDX are scoped + bundled exactly like `svelteBunPlugin`'s (own CSS namespace
 * so the two plugins don't collide).
 */
const MDSVEX_MODULE = "mdsvex" // non-literal so consumers don't need mdsvex's types to typecheck
const STYLE_SUFFIX = "?svelte-mdx-css"
const STYLE_NS = "nifra-svelte-mdx-css"

interface Mdsvex {
  compile(source: string, options?: Record<string, unknown>): Promise<{ code: string } | undefined>
}

/** Build a `Bun.build` plugin that loads `.mdx` files as Svelte components via mdsvex. `generate`:
 * `"ssr"` for the server build, `"dom"` for the client (matches `svelteBunPlugin`). */
export function svelteMdxBunPlugin(generate: "dom" | "ssr"): BunPlugin {
  const cssByPath = new Map<string, string>()
  return {
    name: `nifra-svelte-mdx-${generate}`,
    async setup(build) {
      let mdsvexCompile: Mdsvex["compile"]
      try {
        mdsvexCompile = ((await import(MDSVEX_MODULE)) as Mdsvex).compile
      } catch {
        throw new Error(
          "@nifrajs/web-svelte/mdx: compiling `.mdx` for Svelte needs the `mdsvex` package — install it (`bun add mdsvex`).",
        )
      }
      build.onLoad({ filter: /\.mdx(\?|$)/ }, async (args) => {
        const path = args.path.split("?")[0] ?? args.path
        // 1. Markdown/MDX → Svelte source (mdsvex). `extensions` must include `.mdx` or mdsvex skips the
        // file (returns undefined — it only processes its configured extensions, default `.svx`).
        const pre = await mdsvexCompile(await Bun.file(path).text(), {
          filename: path,
          extensions: [".mdx", ".svx", ".md"],
        })
        if (!pre) throw new Error(`@nifrajs/web-svelte/mdx: mdsvex produced no output for ${path}`)
        // 2. Svelte source → JS, exactly like `svelteBunPlugin`.
        const { js, css } = compile(pre.code, {
          generate: generate === "ssr" ? "server" : "client",
          filename: path,
          css: "external",
        })
        if (generate === "dom" && css?.code) {
          cssByPath.set(path, css.code)
          return {
            contents: `${js.code}\nimport ${JSON.stringify(path + STYLE_SUFFIX)}\n`,
            loader: "js",
          }
        }
        return { contents: js.code, loader: "js" }
      })
      build.onResolve({ filter: /\?svelte-mdx-css$/ }, (args) => ({
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
