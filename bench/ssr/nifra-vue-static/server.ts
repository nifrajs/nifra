import { createWebApp, enumerateStaticRoutes } from "@nifrajs/web"
import type { BuildManifest } from "@nifrajs/web/build"
import { discoverRoutes } from "@nifrajs/web/fs"
import { vueAdapter } from "@nifrajs/web-vue"

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
  adapter: vueAdapter,
  manifest,
  clientEntry: assets.entry,
  routePreload: assets.routes,
  prerenderedPaths,
  staticFallbacks,
  title: "nifra SSR bench (Vue SSG)",
})

app.get("/assets/*", async (c) => {
  const name = new URL(c.req.url).pathname.slice("/assets/".length)
  if (name.includes("..") || name.includes("/")) return new Response("Not Found", { status: 404 })
  const file = Bun.file(`${dist}/${name}`)
  if (!(await file.exists())) return new Response("Not Found", { status: 404 })
  return new Response(file, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
    },
  })
})
