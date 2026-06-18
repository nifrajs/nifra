// Build the client bundle: discover routes (incl. `.mdx`) → codegen → Bun.build (hashed + minified).
// Solid `.tsx` compiles via solidBunPlugin; `.mdx` via solidMdxBunPlugin — both "dom" for the client.
//   bun run examples/mdx-blog/build.ts
import { buildClient } from "@nifrajs/web/build"
import { solidBunPlugin } from "@nifrajs/web-solid"
import { solidMdxBunPlugin } from "@nifrajs/web-solid/mdx"

const manifest = await buildClient({
  routesDir: `${import.meta.dir}/routes`,
  outDir: `${import.meta.dir}/dist`,
  clientModule: "@nifrajs/web-solid/client",
  plugins: [solidBunPlugin("dom"), solidMdxBunPlugin("dom")],
  conditions: ["bun", "solid", "browser"],
})
console.log("built", manifest.entry)
