import { buildClient, prerenderRoutes } from "@nifrajs/web/build"
import { discoverRoutes } from "@nifrajs/web/fs"

const dir = import.meta.dir
const dist = `${dir}/dist`

await buildClient({
  routesDir: `${dir}/routes`,
  outDir: dist,
  clientModule: "@nifrajs/web-preact/client",
  conditions: ["bun", "browser"],
  define: { "process.env.NODE_ENV": '"production"' },
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
