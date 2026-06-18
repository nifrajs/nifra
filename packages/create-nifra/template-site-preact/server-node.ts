import { readFile } from "node:fs/promises"
import { inProcessClient } from "@nifrajs/client"
import { serve } from "@nifrajs/node"
import { createWebApp } from "@nifrajs/web"
import { backend } from "./backend"
import { adapter } from "./framework"
import { clientEntry, manifest } from "./server-manifest"

const app = createWebApp({
  adapter,
  manifest,
  clientEntry,
  api: inProcessClient(backend),
  title: "nifra site",
})

// @nifrajs/node serves app.fetch only — so serve /assets/* (the client bundle) from disk here.
const ASSETS = new URL("./assets/", import.meta.url)
const TYPES: Readonly<Record<string, string>> = { js: "text/javascript", css: "text/css" }

await serve(
  {
    async fetch(req) {
      const { pathname } = new URL(req.url)
      if (pathname.startsWith("/assets/")) {
        const name = pathname.slice("/assets/".length)
        if (!/^[A-Za-z0-9._-]+$/.test(name)) return new Response("bad request", { status: 400 })
        try {
          const body = await readFile(new URL(name, ASSETS))
          const ext = name.slice(name.lastIndexOf(".") + 1)
          return new Response(body, { headers: { "content-type": TYPES[ext] ?? "application/octet-stream" } })
        } catch {
          return new Response("not found", { status: 404 })
        }
      }
      return app.fetch(req)
    },
  },
  { port: Number(process.env.PORT ?? 3000) },
)
