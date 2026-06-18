/**
 * Build + prerender the nifra SSG bench app → bench/ssr/nifra-static/dist/ (index.html + hashed assets).
 */
import { buildClient, prerenderRoutes } from "@nifrajs/web/build"
import { discoverRoutes } from "@nifrajs/web/fs"

const dir = import.meta.dir
const dist = `${dir}/dist`

await buildClient({
  routesDir: `${dir}/routes`,
  outDir: dist,
  clientModule: "@nifrajs/web-react/client",
  conditions: ["bun", "browser"],
  define: { "process.env.NODE_ENV": '"production"' },
})

const { app } = await import("./server")
const { prerendered, skipped } = await prerenderRoutes({
  app,
  routes: discoverRoutes(`${dir}/routes`).routes,
  outDir: dist,
})

if (prerendered.length === 0) {
  console.error("prerender produced no routes")
  for (const s of skipped) console.error(`  skipped ${s.path}: ${s.reason}`)
  process.exit(1)
}

for (const p of prerendered) {
  console.log(`prerendered ${p.path} → dist/${p.file} (${p.bytes} B)`)
}
