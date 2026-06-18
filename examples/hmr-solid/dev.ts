/**
 * True-HMR dev server (Solid) — the `@nifrajs/web/vite` server with `vite-plugin-solid` (client HMR via
 * solid-refresh). `solidBunPlugin("ssr")` (preloaded, see ssr-preload.ts) handles the Bun-side SSR.
 *
 *   bun --preload hmr-solid/ssr-preload.ts hmr-solid/dev.ts
 *   (containers/sandboxes: prefix CHOKIDAR_USEPOLLING=1)
 *
 * Solid needs the `"solid"` resolve condition (routes solid-js to its source/JSX-dev build) — passed
 * via `conditions`. Edit `components/Counter.tsx` while the counter is non-zero — it updates live.
 */

import { inProcessClient } from "@nifrajs/client"
import { createWebApp } from "@nifrajs/web"
import { discoverRoutes } from "@nifrajs/web/fs"
import { createViteDevServer } from "@nifrajs/web/vite"
import { solidAdapter } from "@nifrajs/web-solid"
import solid from "vite-plugin-solid"
import { backend } from "./backend"

const routesDir = `${import.meta.dir}/routes`
const server = await createViteDevServer({
  root: import.meta.dir,
  routesDir,
  clientModule: "@nifrajs/web-solid/client",
  // `ssr: true` makes vite-plugin-solid emit *hydratable* client output (generate: "dom" +
  // hydratable), matching nifra's Bun SSR (solidBunPlugin "ssr") — without it, Solid throws a
  // hydration mismatch ("Failed attempt to create new DOM elements during hydration").
  plugins: [solid({ ssr: true })],
  conditions: ["solid"],
  port: Number(Bun.env.PORT ?? 3000),
  createApp: (clientEntry, importQuery) =>
    createWebApp({
      adapter: solidAdapter,
      manifest: discoverRoutes(routesDir, { importQuery }),
      clientEntry,
      api: inProcessClient(backend),
      title: "nifra HMR (Solid, dev)",
    }),
})
console.log(`dev (HMR): http://localhost:${server.port}`)
