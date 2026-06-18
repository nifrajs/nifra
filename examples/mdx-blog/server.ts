/**
 * nifra MDX blog (Solid) — content collections + an `.mdx` route + `<Content>`, served from a
 * content-hashed production build.
 *
 *   bun run examples/mdx-blog/build.ts
 *   bun --preload examples/mdx-blog/ssr-preload.ts examples/mdx-blog/server.ts
 */
import { inProcessClient } from "@nifrajs/client"
import { createWebApp } from "@nifrajs/web"
import type { BuildManifest } from "@nifrajs/web/build"
import { discoverRoutes } from "@nifrajs/web/fs"
import { solidAdapter } from "@nifrajs/web-solid"
import { backend } from "./backend"

const dist = `${import.meta.dir}/dist`
// Trusted own build output (written by buildClient).
const assets = JSON.parse(
  await Bun.file(`${dist}/manifest.json`)
    .text()
    .catch(() => '{"entry":"/assets/missing.js","assets":[]}'),
) as BuildManifest

export const app = createWebApp({
  adapter: solidAdapter,
  manifest: discoverRoutes(`${import.meta.dir}/routes`),
  clientEntry: assets.entry,
  api: inProcessClient(backend),
  title: "nifra MDX blog (Solid)",
})

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
