import { inProcessClient } from "@nifrajs/client"
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

// Vercel Edge Function — Vercel serves /assets/* from its CDN, so this only SSRs page routes.
export const config = { runtime: "edge" }
export default (req: Request): Response | Promise<Response> => app.fetch(req)
