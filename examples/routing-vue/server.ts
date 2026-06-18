/**
 * routing-vue — the SAME app shape as routing-react/routing-preact on Vue, exercising the
 * @nifrajs/web-vue bindings (useFetcher, useQuery/useQueryClient, <Await>) through the real createWebApp
 * + buildClient pipeline. Proves the bindings work in the production flow (SSR data, client nav,
 * deferred resolution) — not just in isolation.
 *
 *   bun run examples/routing-vue/build.ts
 *   bun examples/routing-vue/server.ts        # Vue render functions are Bun-native (no SFC compiler)
 */
import { inProcessClient } from "@nifrajs/client"
import { createWebApp } from "@nifrajs/web"
import type { BuildManifest } from "@nifrajs/web/build"
import { discoverRoutes } from "@nifrajs/web/fs"
import { vueAdapter } from "@nifrajs/web-vue"
import { backend } from "./backend"

const routesDir = `${import.meta.dir}/routes`
const dist = `${import.meta.dir}/dist`
// Trusted own build output (written by buildClient) — cast after parse.
const assets = JSON.parse(
  await Bun.file(`${dist}/manifest.json`)
    .text()
    .catch(() => '{"entry":"/assets/missing.js","assets":[],"routes":{}}'),
) as BuildManifest

const manifest = discoverRoutes(routesDir)
const api = inProcessClient(backend)
// `export` so the build can prerender it (the SSG driver drives `app.fetch`); see build.ts.
export const app = createWebApp({
  adapter: vueAdapter,
  manifest,
  clientEntry: assets.entry,
  routePreload: assets.routes,
  api,
  title: "nifra (Vue)",
})

// Serve the content-hashed bundle. Hashed URLs are safe to cache immutably.
app.get("/assets/*", async (c) => {
  const name = new URL(c.req.url).pathname.slice("/assets/".length)
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return new Response("Bad Request", { status: 400 })
  const file = Bun.file(`${dist}/${name}`)
  if (!(await file.exists())) return new Response("Not Found", { status: 404 })
  return new Response(file, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
    },
  })
})

// Only listen when run directly — when imported (by build.ts for prerendering), we just want `app`.
if (import.meta.main) {
  const running = app.listen(Number(Bun.env.PORT ?? 3000))
  console.log(`http://localhost:${running.port}`)
}
