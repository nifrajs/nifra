import { inProcessClient } from "@nifrajs/client"
import { createWebApp } from "@nifrajs/web"
import { reactAdapter } from "@nifrajs/web-react"
import { backend } from "./backend"
import { clientEntry, manifest } from "./server-manifest"

const app = createWebApp({
  adapter: reactAdapter,
  manifest,
  clientEntry,
  api: inProcessClient(backend),
  title: "nifra site",
})

// Bun (Nifra's flagship runtime): Bun.serve handles app.fetch; serve the client bundle (/assets/*)
// from disk with Bun.file. Assets live next to this file in the built dist-bun/ output.
const ASSETS = new URL("./assets/", import.meta.url)
const TYPES: Readonly<Record<string, string>> = {
  js: "text/javascript",
  css: "text/css",
  svg: "image/svg+xml",
  png: "image/png",
}

const server = Bun.serve({
  port: Number(Bun.env.PORT ?? 3000),
  async fetch(req) {
    const { pathname } = new URL(req.url)
    if (pathname.startsWith("/assets/")) {
      const name = pathname.slice("/assets/".length)
      if (!/^[A-Za-z0-9._-]+$/.test(name)) return new Response("bad request", { status: 400 })
      const file = Bun.file(new URL(name, ASSETS))
      if (!(await file.exists())) return new Response("not found", { status: 404 })
      const ext = name.slice(name.lastIndexOf(".") + 1)
      return new Response(file, {
        headers: { "content-type": TYPES[ext] ?? "application/octet-stream" },
      })
    }
    return app.fetch(req)
  },
})
console.log(`nifra (Bun) → http://localhost:${server.port}`)
