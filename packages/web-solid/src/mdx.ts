/**
 * `solidMdxBunPlugin` — compile `.mdx` routes/files to **Solid** components. MDX is JSX-oriented but
 * Solid's JSX is compile-time, so this: (1) compiles MDX → JSX with `@mdx-js` (keeping JSX), pointing
 * intrinsic elements at `@nifrajs/web-solid/mdx-runtime` (which renders them via Solid's `<Dynamic>`), then
 * (2) runs `babel-preset-solid` — the same transform `solidBunPlugin` applies to `.tsx`. Pass it to
 * `buildClient`/`buildServer`'s `plugins` (`"dom"` for the client, `"ssr"` for the server), like
 * `solidBunPlugin`. `@mdx-js/mdx` is an optional peer (lazy-loaded at build time).
 */
import { transformAsync } from "@babel/core"
// @ts-expect-error — no type declarations published
import presetTypeScript from "@babel/preset-typescript"
// @ts-expect-error — no type declarations published
import presetSolid from "babel-preset-solid"
import type { BunPlugin } from "bun"

// Non-literal so tsc/consumers don't need `@mdx-js/mdx`'s types to typecheck this file (optional peer).
const MDX_MODULE = "@mdx-js/mdx"

interface MdxCompiler {
  compile(source: string, options?: Record<string, unknown>): Promise<{ toString(): string }>
}

/** Build a `Bun.build` plugin that loads `.mdx` files as Solid components. `generate`: `"ssr"` for the
 * server build, `"dom"` for the client (matches `solidBunPlugin`). */
export function solidMdxBunPlugin(generate: "dom" | "ssr"): BunPlugin {
  return {
    name: `nifra-solid-mdx-${generate}`,
    async setup(build) {
      let compile: MdxCompiler["compile"]
      try {
        compile = ((await import(MDX_MODULE)) as MdxCompiler).compile
      } catch {
        throw new Error(
          "@nifrajs/web-solid/mdx: compiling `.mdx` needs the `@mdx-js/mdx` package — install it (`bun add @mdx-js/mdx`).",
        )
      }
      build.onLoad({ filter: /\.mdx(\?|$)/ }, async (args) => {
        const path = args.path.split("?")[0] ?? args.path
        // 1. MDX → JSX, with intrinsics provided by the Solid runtime (rendered via `<Dynamic>`).
        const jsx = String(
          await compile(await Bun.file(path).text(), {
            jsx: true,
            providerImportSource: "@nifrajs/web-solid/mdx-runtime",
          }),
        )
        // 2. babel-preset-solid (TS stripped first), exactly like `solidBunPlugin`.
        const result = await transformAsync(jsx, {
          filename: `${path}.tsx`,
          presets: [
            [presetSolid, { generate, hydratable: true }],
            [presetTypeScript, { onlyRemoveTypeImports: true }],
          ],
          babelrc: false,
          configFile: false,
        })
        return { contents: result?.code ?? "", loader: "js" }
      })
    },
  }
}
