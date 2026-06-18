/**
 * The site on Deno — the same Nifra app, served by `@nifrajs/deno` (Deno.serve under the hood). Like
 * the Node entry, it wraps `app.fetch` with a `/assets/*` static handler (reading the client bundle
 * via `Deno.readFile`), since the adapter serves `app.fetch` only.
 *
 *   deno run --allow-net --allow-read --allow-env site/dist-deno/server-deno.js   (built by build-deno.ts)
 */
import { inProcessClient } from "@nifrajs/client"
import { serve } from "@nifrajs/deno"
import { createWebApp } from "@nifrajs/web"
import { reactAdapter } from "@nifrajs/web-react"
import { backend } from "./backend"
import { clientEntry, manifest } from "./server-manifest"

const app = createWebApp({
  adapter: reactAdapter,
  manifest,
  clientEntry,
  api: inProcessClient(backend),
  title: "nifra",
})

const ASSETS_DIR = new URL("./assets/", import.meta.url)
const CONTENT_TYPE: Readonly<Record<string, string>> = {
  js: "text/javascript",
  css: "text/css",
  map: "application/json",
}

await serve(
  {
    async fetch(req) {
      const { pathname } = new URL(req.url)
      if (pathname.startsWith("/assets/")) {
        const name = pathname.slice("/assets/".length)
        if (!/^[A-Za-z0-9._-]+$/.test(name)) return new Response("bad request", { status: 400 })
        try {
          const body = await Deno.readFile(new URL(name, ASSETS_DIR))
          const ext = name.slice(name.lastIndexOf(".") + 1)
          return new Response(body, {
            headers: { "content-type": CONTENT_TYPE[ext] ?? "application/octet-stream" },
          })
        } catch {
          return new Response("not found", { status: 404 })
        }
      }
      return app.fetch(req)
    },
  },
  { port: Number(Deno.env.get("PORT") ?? "3000") },
)
