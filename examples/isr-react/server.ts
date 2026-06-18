/**
 * ISR (Incremental Static Regeneration) demo on Bun — a nifra app whose document responses are cached
 * and served stale-while-revalidate by `withISR`, backed by an in-memory store for local dev. The
 * index route declares `revalidate = 2` (seconds).
 *
 *   bun run examples/isr-react/build.ts     # build the client bundle first
 *   bun examples/isr-react/server.ts        # then serve with ISR
 *
 * Watch the `x-nifra-isr` response header: `miss` (rendered + stored) → `hit` (fresh, from cache) →
 * `stale` (served instantly while it regenerates behind the request). On-demand purge:
 *   curl -X POST 'http://localhost:3000/__nifra/revalidate?path=/' -H 'x-nifra-revalidate-token: dev-secret'
 *
 * Production swaps the in-memory store for a shared KV store (worker.ts) so the cache and purges hold
 * across instances — the only line that changes is the store.
 */
import { inProcessClient } from "@nifrajs/client"
import { createWebApp, MemoryCacheStore, revalidateEndpoint, withISR } from "@nifrajs/web"
import type { BuildManifest } from "@nifrajs/web/build"
import { discoverRoutes } from "@nifrajs/web/fs"
import { reactAdapter } from "@nifrajs/web-react"
import { backend } from "./backend"

// buildClient writes to public/assets (so /assets/* maps to a file under the assets dir — the layout
// Workers Assets also uses, see worker.ts). Trusted own build output — cast after parse.
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
  title: "nifra — ISR demo",
})

// Serve the content-hashed bundle (immutable — hashed URLs). The ISR `key` below skips these. The
// pathname is /assets/<hash>.js → public/assets/<hash>.js (Workers Assets serves the same layout).
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

// The ISR cache + the on-demand purge endpoint share ONE store instance. The purge is a POST, so
// `withISR` passes it straight through to this route (it only caches GET document responses). Use a
// real secret in production (env), and prefer POST-from-trusted-origin only.
const store = new MemoryCacheStore()
const secret = Bun.env.REVALIDATE_SECRET ?? "dev-secret"
const purge = revalidateEndpoint({ store, secret })
app.post("/__nifra/revalidate", (c) => purge(c.req))

// Wrap the app: GET text/html responses are cached + served stale-while-revalidate. Default freshness
// 10s; the index route overrides it to 2s via `export const revalidate`. The `key` returns null for
// /assets/* so hashed bundles bypass the page cache (no point storing immutable files in it).
const isr = withISR(app, {
  store,
  revalidate: 10,
  now: () => Date.now(),
  key: (req) => {
    const url = new URL(req.url)
    return url.pathname.startsWith("/assets/") ? null : url.origin + url.pathname + url.search
  },
})

if (import.meta.main) {
  const running = Bun.serve({ port: Number(Bun.env.PORT ?? 3000), fetch: (req) => isr(req) })
  console.log(`http://localhost:${running.port}`)
}
