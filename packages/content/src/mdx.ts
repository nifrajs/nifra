/**
 * `mdxBunPlugin` — a `Bun.build` plugin that compiles `.mdx` files (Markdown + JSX components) into
 * components for your UI framework, so an `.mdx` file can be a nifra route or be imported like a module.
 * Pass it to `buildClient`/`buildServer`'s `plugins`, and add `.mdx` to your route discovery.
 *
 *   import { buildClient } from "@nifrajs/web/build"
 *   import { mdxBunPlugin } from "@nifrajs/content/mdx"
 *
 *   await buildClient({
 *     routesDir: "./routes",
 *     clientModule: "@nifrajs/web-react/client",
 *     plugins: [mdxBunPlugin({ jsxImportSource: "react" })],
 *   })
 *
 * MDX is JSX-oriented, so this targets the JSX family (React/Preact/Solid) via `jsxImportSource`. Needs
 * `@mdx-js/mdx` installed (an optional peer — lazy-loaded at build time only).
 */
import type { BunPlugin } from "bun"

export interface MdxPluginOptions {
  /** JSX runtime source the compiled MDX imports from — `"react"` (default), `"preact"`, `"solid-js"`. */
  readonly jsxImportSource?: string
  /** Emit development JSX (line numbers, `jsxDEV`). Default `false`. */
  readonly development?: boolean
  /** Extra `@mdx-js/mdx` `compile` options — e.g. `remarkPlugins`/`rehypePlugins` (GFM, slugs, …). */
  readonly compileOptions?: Record<string, unknown>
  /** Advanced: override the compiler module specifier (default `"@mdx-js/mdx"`) — e.g. to use a fork. */
  readonly moduleName?: string
}

// Non-literal specifier so tsc/consumers don't need `@mdx-js/mdx`'s types to typecheck this file — it's
// an optional peer, imported only when the plugin actually runs (mirrors `@nifrajs/node`'s lazy `ws`).
const MDX_MODULE = "@mdx-js/mdx"

interface MdxCompiler {
  compile(source: string, options?: Record<string, unknown>): Promise<{ toString(): string }>
}

/**
 * Build a `Bun.build` plugin that loads `.mdx` files as compiled components. The compiled module's
 * default export is the MDX content component; `.mdx` files may `import` and use components inline and
 * `export const meta = …` like any route module.
 */
export function mdxBunPlugin(options: MdxPluginOptions = {}): BunPlugin {
  const jsxImportSource = options.jsxImportSource ?? "react"
  const development = options.development ?? false
  return {
    name: "nifra-mdx",
    async setup(build) {
      let compile: MdxCompiler["compile"]
      try {
        const mod = (await import(options.moduleName ?? MDX_MODULE)) as MdxCompiler
        compile = mod.compile
      } catch {
        throw new Error(
          "@nifrajs/content/mdx: compiling `.mdx` needs the `@mdx-js/mdx` package — install it (`bun add @mdx-js/mdx`).",
        )
      }
      // Tolerate a `?query` suffix — `nifra dev` (Vite) appends an import-cache-busting query so edited
      // `.mdx` re-SSR; strip it before reading off disk.
      build.onLoad({ filter: /\.mdx(\?|$)/ }, async (args) => {
        const path = args.path.split("?")[0] ?? args.path
        const source = await Bun.file(path).text()
        const compiled = await compile(source, {
          jsxImportSource,
          development,
          ...options.compileOptions,
        })
        // `loader: "jsx"` — the compiled output still contains JSX; Bun applies the JSX transform with
        // the active `jsxImportSource`. Markup is hydration-equivalent to a hand-written component.
        return { contents: String(compiled), loader: "jsx" }
      })
    },
  }
}
