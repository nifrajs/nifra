/**
 * routing-vue-sfc — nifra + Vue authored as **`.vue` Single-File Components** (contrast `routing-vue`,
 * which uses render functions). Route discovery matches `.vue`; each route's loader/action/meta come
 * from its plain `<script>` block, the component from `<script setup>` + `<template>`. The same
 * createWebApp + buildClient pipeline, just the Vue SFC compiler plugin. Run with the SSR plugin
 * preloaded (it compiles the `.vue` imports):
 *
 *   bun run examples/routing-vue-sfc/build.ts
 *   bun --preload examples/routing-vue-sfc/ssr-preload.ts examples/routing-vue-sfc/server.ts
 */
import { inProcessClient } from "@nifrajs/client"
import { createWebApp } from "@nifrajs/web"
import type { BuildManifest } from "@nifrajs/web/build"
import { discoverRoutes } from "@nifrajs/web/fs"
import { vueAdapter } from "@nifrajs/web-vue"
import { backend } from "./backend"

const routesDir = `${import.meta.dir}/routes`
const dist = `${import.meta.dir}/dist`
const assets = JSON.parse(
  await Bun.file(`${dist}/manifest.json`)
    .text()
    .catch(() => '{"entry":"/assets/missing.js","assets":[],"routes":{}}'),
) as BuildManifest

const manifest = discoverRoutes(routesDir)
const api = inProcessClient(backend)
export const app = createWebApp({
  adapter: vueAdapter,
  manifest,
  clientEntry: assets.entry,
  routePreload: assets.routes,
  api,
  title: "nifra (Vue SFC)",
})

// Serve the content-hashed client bundle (immutable — the hash changes on every content change).
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

if (import.meta.main) {
  const running = app.listen(Number(Bun.env.PORT ?? 3000))
  console.log(`http://localhost:${running.port}`)
}
