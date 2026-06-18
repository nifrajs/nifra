/**
 * Local Bun dev server (no wrangler) — the same app with an in-memory ISR store. `bun run dev:bun`
 * after `bun run build`. Production uses Workers KV (worker.ts); the only line that changes is the
 * store. Watch the `x-nifra-isr` response header: miss → hit → stale.
 */
import { inProcessClient } from "@nifrajs/client"
import { createWebApp, MemoryCacheStore, revalidateEndpoint, withISR } from "@nifrajs/web"
import type { BuildManifest } from "@nifrajs/web/build"
import { discoverRoutes } from "@nifrajs/web/fs"
import { reactAdapter } from "@nifrajs/web-react"
import { backend } from "./backend"

const publicDir = `${import.meta.dir}/public`
const assets = JSON.parse(
  await Bun.file(`${publicDir}/assets/manifest.json`)
    .text()
    .catch(() => '{"entry":"/assets/missing.js","assets":[],"routes":{}}'),
) as BuildManifest

const app = createWebApp({
  adapter: reactAdapter,
  manifest: discoverRoutes(`${import.meta.dir}/routes`),
  clientEntry: assets.entry,
  routePreload: assets.routes,
  api: inProcessClient(backend),
  title: "nifra + ISR",
})

app.get("/assets/*", async (c) => {
  const file = Bun.file(`${publicDir}${new URL(c.req.url).pathname}`)
  if (!(await file.exists())) return new Response("Not Found", { status: 404 })
  return new Response(file, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
    },
  })
})

const store = new MemoryCacheStore()
const secret = Bun.env.REVALIDATE_SECRET ?? "dev-secret"
const purge = revalidateEndpoint({ store, secret })
app.post("/__nifra/revalidate", (c) => purge(c.req))

const isr = withISR(app, {
  store,
  revalidate: 60,
  now: () => Date.now(),
  key: (req) => {
    const url = new URL(req.url)
    return url.pathname.startsWith("/assets/") ? null : url.origin + url.pathname + url.search
  },
})

const running = Bun.serve({ port: Number(Bun.env.PORT ?? 3000), fetch: (req) => isr(req) })
console.log(`http://localhost:${running.port}`)
