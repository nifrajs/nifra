/**
 * `solidMdxBunPlugin` - compile `.mdx` routes/files to **Solid** components. MDX is JSX-oriented but
 * Solid's JSX is compile-time, so this: (1) compiles MDX → JSX with `@mdx-js` (keeping JSX), pointing
 * intrinsic elements at `@nifrajs/web-solid/mdx-runtime` (which renders them via Solid's `dynamic()`), then
 * (2) runs `@solidjs/compiler` - the same transform `solidBunPlugin` applies to `.tsx`. Pass it to
 * `buildClient`/`buildServer`'s `plugins` (`"dom"` for the client, `"ssr"` for the server), like
 * `solidBunPlugin`. `@mdx-js/mdx` is an optional peer (lazy-loaded at build time).
 */
import { normalizeFilePath, requirePeer, rewriteSsrImports } from "@nifrajs/web/plugins/kit"
import { transformAsync } from "@solidjs/compiler"
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
      const { compile } = await requirePeer<MdxCompiler>(MDX_MODULE, {
        feature: "Solid MDX support",
        install: "bun add @mdx-js/mdx",
      })
      build.onLoad({ filter: /\.mdx(\?|$)/ }, async (args) => {
        const path = normalizeFilePath(args.path)
        // 1. MDX → JSX, with intrinsics provided by the Solid runtime (rendered via `dynamic()`).
        const jsx = String(
          await compile(await Bun.file(path).text(), {
            jsx: true,
            providerImportSource: "@nifrajs/web-solid/mdx-runtime",
          }),
        )
        // 2. The Solid compile, exactly like `solidBunPlugin`.
        const result = await transformAsync(jsx, {
          filename: `${path}.tsx`,
          generate,
          hydratable: true,
        })
        return { contents: rewriteSsrImports(result.code, path, generate), loader: "ts" }
      })
    },
  }
}
