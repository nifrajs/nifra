/**
 * nifra + React SSG bench — `createWebApp` used only at build/prerender time; steady-state serving is
 * the prerendered `dist/` via bench/ssr/static-server.ts (Table B).
 */
import { createWebApp, enumerateStaticRoutes } from "@nifrajs/web"
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

const manifest = discoverRoutes(routesDir)
const { paths: prerenderedPaths, fallbacks: staticFallbacks } = await enumerateStaticRoutes(
  manifest.routes,
)

export const app = createWebApp({
  adapter: reactAdapter,
  manifest,
  clientEntry: assets.entry,
  routePreload: assets.routes,
  prerenderedPaths,
  staticFallbacks,
  title: "nifra SSR bench (SSG)",
})

app.get("/assets/*", async (c) => {
  const name = new URL(c.req.url).pathname.slice("/assets/".length)
  if (name.includes("..")) return new Response("Not Found", { status: 404 })
  const file = Bun.file(`${dist}/${name}`) // URL /assets/<file> → dist/<file> (see buildClient publicPath)
  if (!(await file.exists())) return new Response("Not Found", { status: 404 })
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
