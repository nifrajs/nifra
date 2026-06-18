/**
 * The site on Node — the same Nifra app, served by `@nifrajs/node`. Cloudflare serves the client bundle
 * via `_routes.json`; on Node we hand `serve` a `static` mount so it serves `/assets/*` from disk
 * before the app runs (the SSR/API fast path stays intact for everything else).
 *
 *   node site/dist-node/server-node.js     (built by build-node.ts)
 */
import { inProcessClient } from "@nifrajs/client"
import { serve } from "@nifrajs/node"
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

await serve(app, {
  port: Number(process.env.PORT ?? 3000),
  static: { dir: new URL("./assets/", import.meta.url) },
})
