/**
 * F5 example — the SAME app as routing-solid on React, served from a content-hashed production
 * build. `buildClient` writes dist/manifest.json; the server reads the hashed entry + serves the
 * hashed assets with immutable cache headers.
 *
 *   bun run examples/routing-react/build.ts
 *   bun examples/routing-react/server.ts        # no SSR preload — React JSX is Bun-native
 */
import { inProcessClient } from "@nifrajs/client"
import { createWebApp, enumerateStaticRoutes } from "@nifrajs/web"
import type { BuildManifest } from "@nifrajs/web/build"
import { discoverRoutes } from "@nifrajs/web/fs"
import { reactAdapter } from "@nifrajs/web-react"
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
// The SSG static-routing facts: the prerendered-path set (index + the users getStaticPaths) + each
// dynamic route's `fallback`. `prerenderedPaths` is injected so a client soft-nav INTO a prerendered
// route fetches its static `_data.json` (no worker); `staticFallbacks` lets a `fallback: "404"` route
// reject unlisted paths (here `/users/:id` is the default "ssr", so unlisted ids still render
// on-demand). A production server could read both from the build's dist/prerendered.json instead.
const { paths: prerenderedPaths, fallbacks: staticFallbacks } = await enumerateStaticRoutes(
  manifest.routes,
)
// `export` so the build can prerender it (the SSG driver drives `app.fetch`); see build.ts.
export const app = createWebApp({
  adapter: reactAdapter,
  manifest,
  clientEntry: assets.entry,
  // Each page modulepreloads its matched route's chunks (built map) alongside the entry — the route
  // code downloads in parallel instead of after the entry discovers the lazy import.
  routePreload: assets.routes,
  // The app's bundled stylesheet (`buildClient`'s manifest.css) → `<link rel="stylesheet">` in every
  // page's <head>. Here `import "./app.css"` in _layout is the global stylesheet.
  styles: assets.css,
  prerenderedPaths,
  staticFallbacks,
  api,
  title: "nifra F5 (React)",
})

// Serve the content-hashed bundle. Hashed URLs are safe to cache immutably.
app.get("/assets/*", async (c) => {
  const name = new URL(c.req.url).pathname.slice("/assets/".length)
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return new Response("Bad Request", { status: 400 })
  const file = Bun.file(`${dist}/${name}`)
  if (!(await file.exists())) return new Response("Not Found", { status: 404 })
  // Content-type by extension: `.css` assets must be `text/css`, everything else is JS.
  const contentType = name.endsWith(".css")
    ? "text/css; charset=utf-8"
    : "text/javascript; charset=utf-8"
  return new Response(file, {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=31536000, immutable",
    },
  })
})

// Only listen when run directly (`bun server.ts`) — when imported (by build.ts for prerendering),
// we just want the `app`, not a live server.
if (import.meta.main) {
  const running = app.listen(Number(Bun.env.PORT ?? 3000))
  console.log(`http://localhost:${running.port}`)
}
