// Build the client bundle via @nifrajs/web/build: discover routes → codegen → Bun.build, now
// content-hashed + minified, writing dist/manifest.json (read by server.ts). Then PRERENDER (SSG).
//   bun run examples/routing-solid/build.ts
import { buildClient, prerenderRoutes } from "@nifrajs/web/build"
import { discoverRoutes } from "@nifrajs/web/fs"
import { solidBunPlugin } from "@nifrajs/web-solid"
import { plugin } from "bun"

const dist = `${import.meta.dir}/dist`
const manifest = await buildClient({
  routesDir: `${import.meta.dir}/routes`,
  outDir: dist,
  clientModule: "@nifrajs/web-solid/client",
  plugins: [solidBunPlugin("dom")],
  conditions: ["bun", "solid", "browser"],
})
console.log("built", manifest.entry)

// SSG on Solid: prerendering renders components SERVER-SIDE in THIS process, so register Solid's SSR
// transform globally NOW — AFTER buildClient (which scoped its own "dom" transform to that build) and
// BEFORE importing the app, so the dynamically-imported route .tsx get the "ssr" generate. Then SSG.
plugin(solidBunPlugin("ssr"))
const { app } = await import("./server")
const { prerendered } = await prerenderRoutes({
  app,
  routes: discoverRoutes(`${import.meta.dir}/routes`).routes,
  outDir: dist,
})
for (const p of prerendered) console.log(`prerendered ${p.path} → dist/${p.file} (${p.bytes} B)`)
