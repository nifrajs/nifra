/**
 * nifra + React ISR bench — `withISR` caches GET HTML; runner warms the store before measuring.
 */
import { createWebApp, MemoryCacheStore, withISR } from "@nifrajs/web"
import type { BuildManifest } from "@nifrajs/web/build"
import { discoverRoutes } from "@nifrajs/web/fs"
import { reactAdapter } from "@nifrajs/web-react"

const routesDir = `${import.meta.dir}/routes`
const dist = `${import.meta.dir}/dist`

const assets = JSON.parse(
  await Bun.file(`${dist}/manifest.json`)
    .text()
    .catch(() => '{"entry":"/assets/missing.js","assets":[],"routes":{}}'),
) as BuildManifest

const app = createWebApp({
  adapter: reactAdapter,
  manifest: discoverRoutes(routesDir),
  clientEntry: assets.entry,
  routePreload: assets.routes,
  title: "nifra SSR bench (ISR)",
})

app.get("/assets/*", async (c) => {
  const name = new URL(c.req.url).pathname.slice("/assets/".length)
  if (name.includes("..")) return new Response("Not Found", { status: 404 })
  const file = Bun.file(`${dist}/${name}`)
  if (!(await file.exists())) return new Response("Not Found", { status: 404 })
  return new Response(file, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
    },
  })
})

const store = new MemoryCacheStore({ allowInProduction: true })
const isr = withISR(app, {
  store,
  revalidate: 3600,
  now: () => Date.now(),
  key: (req) => {
    const url = new URL(req.url)
    return url.pathname.startsWith("/assets/") ? null : url.pathname + url.search
  },
})

const port = Number(Bun.env.PORT ?? 4313)
const running = Bun.serve({ port, fetch: (req) => isr(req) })
console.log(`nifra-isr http://localhost:${running.port}`)
