/**
 * The site as a Vercel Edge Function — a Web-standard fetch handler (the same edge build as the
 * Cloudflare worker). Vercel serves /assets/* from its CDN (static output), so this function only
 * SSRs page routes; no static handler needed here.
 *
 * Deploy: place the built handler as a Vercel Edge Function (Build Output API
 * `.vercel/output/functions/index.func` with `runtime: "edge"`) and the client bundle in the static
 * output. (Built + handler-verified locally; the deploy is the user's step — no Vercel creds here.)
 */
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
  title: "nifra",
})

export const config = { runtime: "edge" }

export default (req: Request): Response | Promise<Response> => app.fetch(req)
