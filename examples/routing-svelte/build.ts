// Build the client bundle via @nifrajs/web/build: discover routes (.svelte) → codegen → Bun.build,
// content-hashed + minified, writing dist/manifest.json (read by server.ts). The svelteBunPlugin("dom")
// compiles the .svelte route components (+ the adapter's Chain/Router/Await) for the browser. Then
// PRERENDER (SSG).
//   bun run examples/routing-svelte/build.ts
import { buildClient, prerenderRoutes } from "@nifrajs/web/build"
import { discoverRoutes } from "@nifrajs/web/fs"
import { svelteBunPlugin } from "@nifrajs/web-svelte/plugin"
import { plugin } from "bun"

const dist = `${import.meta.dir}/dist`
const manifest = await buildClient({
  routesDir: `${import.meta.dir}/routes`,
  outDir: dist,
  clientModule: "@nifrajs/web-svelte/client",
  plugins: [svelteBunPlugin("dom")],
  conditions: ["bun", "browser"],
  define: { "process.env.NODE_ENV": '"production"' },
})
console.log("built", manifest.entry)

// SSG on Svelte: prerendering compiles + renders .svelte components SERVER-SIDE in THIS process, so
// register Svelte's SSR-generate transform globally NOW — AFTER buildClient (which scoped its own
// "dom" compile to that build) and BEFORE importing the app, so the dynamically-imported .svelte
// routes get the "ssr" generate. Then drive the SSG.
plugin(svelteBunPlugin("ssr"))
const { app } = await import("./server")
const { prerendered } = await prerenderRoutes({
  app,
  routes: discoverRoutes(`${import.meta.dir}/routes`).routes,
  outDir: dist,
})
for (const p of prerendered) console.log(`prerendered ${p.path} → dist/${p.file} (${p.bytes} B)`)
