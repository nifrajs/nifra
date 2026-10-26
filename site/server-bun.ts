import { inProcessClient } from "@nifrajs/client"
import { ONE_DAY, serveStatic } from "@nifrajs/core/serve-static"
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
  title: "nifra site",
})

// Bun (Nifra's flagship runtime) on app.listen(): `static` answers the machine surfaces and the client
// bundle ahead of every route, Bun's route table included. The bundle sits in assets/ next to this file
// in the built dist-bun/ output. Its manifest names the content-hashed files, the only ones cached as
// immutable: the fonts and media copied beside them keep their names across builds.
const built: unknown = await Bun.file(new URL("./assets/manifest.json", import.meta.url)).json()
const hashed: unknown =
  typeof built === "object" && built !== null ? Reflect.get(built, "assets") : []
const assets = serveStatic({
  dir: new URL("./assets/", import.meta.url),
  hashedFiles: Array.isArray(hashed) ? hashed.filter((path) => typeof path === "string") : [],
  cacheControl: ONE_DAY,
})

const server = app.listen(Number(Bun.env.PORT ?? 3000), {
  static(req) {
    const machineSurface = machineSurfaceFor(req)
    if (machineSurface !== undefined) return machineSurface
    return assets(req)
  },
})
console.log(`nifra (Bun) → http://localhost:${server.port}`)
