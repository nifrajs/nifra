/**
 * The site on Deno - the same Nifra app, served by `@nifrajs/deno` (Deno.serve under the hood). The
 * adapter's `static` answers the machine surfaces and the client bundle under `/assets/` ahead of
 * every route.
 *
 *   deno run --allow-net --allow-read --allow-env site/dist-deno/server-deno.js   (built by build-deno.ts)
 */
import { inProcessClient } from "@nifrajs/client"
import { serve, serveStatic } from "@nifrajs/deno"
import { createWebApp } from "@nifrajs/web"
import { reactAdapter } from "@nifrajs/web-react"
import { backend } from "./backend/app"
import { machineSurfaceFor } from "./backend/machine-surfaces"
import { clientEntry, manifest } from "./server-manifest"

const app = createWebApp({
  adapter: reactAdapter,
  manifest,
  clientEntry,
  api: inProcessClient(backend),
  title: "nifra",
})

const assets = serveStatic({ dir: new URL("./assets/", import.meta.url), immutable: false })

await serve(app, {
  port: Number(Deno.env.get("PORT") ?? "3000"),
  static(req) {
    const machineSurface = machineSurfaceFor(req)
    if (machineSurface !== undefined) return machineSurface
    return assets(req)
  },
})
