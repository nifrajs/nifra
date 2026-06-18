// Build the client bundle via @nifrajs/web/build: discover routes → codegen → Bun.build, content-hashed
// + minified, writing dist/manifest.json (read by server.ts). The Vue route components are render
// functions (defineComponent + h) in .tsx files with no JSX, so no SFC compiler / build plugin is
// needed. The __VUE_* defines silence Vue's prod feature-flag warnings.
//   bun run examples/routing-vue/build.ts
import { buildClient, prerenderRoutes } from "@nifrajs/web/build"
import { discoverRoutes } from "@nifrajs/web/fs"

const dist = `${import.meta.dir}/dist`
const manifest = await buildClient({
  routesDir: `${import.meta.dir}/routes`,
  outDir: dist,
  clientModule: "@nifrajs/web-vue/client",
  conditions: ["bun", "browser"],
  define: {
    "process.env.NODE_ENV": '"production"',
    __VUE_OPTIONS_API__: "true",
    __VUE_PROD_DEVTOOLS__: "false",
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
  },
})
console.log("built", manifest.entry)

// SSG: prerender opted-in static routes to static HTML (proves the agnostic prerender pipeline on
// Vue). Import the app AFTER buildClient so it reads the fresh manifest.json → the prerendered HTML
// references the just-built hashed entry.
const { app } = await import("./server")
const { prerendered } = await prerenderRoutes({
  app,
  routes: discoverRoutes(`${import.meta.dir}/routes`).routes,
  outDir: dist,
})
for (const p of prerendered) console.log(`prerendered ${p.path} → dist/${p.file} (${p.bytes} B)`)
