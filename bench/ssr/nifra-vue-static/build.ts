import { buildClient, prerenderRoutes } from "@nifrajs/web/build"
import { discoverRoutes } from "@nifrajs/web/fs"

const dir = import.meta.dir
const dist = `${dir}/dist`

await buildClient({
  routesDir: `${dir}/routes`,
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

const { app } = await import("./server")
const { prerendered } = await prerenderRoutes({
  app,
  routes: discoverRoutes(`${dir}/routes`).routes,
  outDir: dist,
})

if (prerendered.length === 0) {
  console.error("prerender produced no routes")
  process.exit(1)
}
for (const p of prerendered) console.log(`prerendered ${p.path} → dist/${p.file} (${p.bytes} B)`)
