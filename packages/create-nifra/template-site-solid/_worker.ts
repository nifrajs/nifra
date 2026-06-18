import { inProcessClient } from "@nifrajs/client"
import { toFetchHandler } from "@nifrajs/core"
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

// Cloudflare Pages: _routes.json serves /assets/* statically; everything else hits this (SSR).
export default toFetchHandler(app)
