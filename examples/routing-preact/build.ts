// Build the client bundle via @nifrajs/web/build: discover routes → codegen → Bun.build, content-hashed
// + minified, writing dist/manifest.json (read by server.ts). The route .tsx files carry a
// `/** @jsxImportSource preact */` pragma, so Bun transpiles their JSX to preact/jsx-runtime — no
// build plugin needed (contrast routing-solid's Babel preload).
//   bun run examples/routing-preact/build.ts
import { buildClient, prerenderRoutes } from "@nifrajs/web/build"
import { discoverRoutes } from "@nifrajs/web/fs"

const dist = `${import.meta.dir}/dist`
const manifest = await buildClient({
  routesDir: `${import.meta.dir}/routes`,
  outDir: dist,
  clientModule: "@nifrajs/web-preact/client",
  conditions: ["bun", "browser"],
  define: { "process.env.NODE_ENV": '"production"' },
})
console.log("built", manifest.entry)

// SSG: prerender opted-in static routes to static HTML (proves the agnostic prerender pipeline on
// Preact). Import the app AFTER buildClient so it reads the fresh manifest.json.
const { app } = await import("./server")
const { prerendered } = await prerenderRoutes({
  app,
  routes: discoverRoutes(`${import.meta.dir}/routes`).routes,
  outDir: dist,
})
for (const p of prerendered) console.log(`prerendered ${p.path} → dist/${p.file} (${p.bytes} B)`)
