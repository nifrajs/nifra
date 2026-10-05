/**
 * True-HMR dev server (Solid) - the `@nifrajs/web/vite` server with `vite-plugin-solid` (client HMR via
 * solid-refresh). The same plugin compiles route modules for SSR: `createApp`'s `load` resolves them
 * through Vite, so a server render reflects the latest edit.
 *
 *   bun hmr-solid/dev.ts
 *   (containers/sandboxes: prefix CHOKIDAR_USEPOLLING=1)
 *
 * Solid needs the `"solid"` resolve condition (routes solid-js to its source/JSX-dev build) - passed
 * via `conditions`. Edit `components/Counter.tsx` while the counter is non-zero - it updates live.
 */

import { inProcessClient } from "@nifrajs/client"
import { createWebApp } from "@nifrajs/web"
import { discoverRoutes } from "@nifrajs/web/fs"
import { createViteDevServer } from "@nifrajs/web/vite"
import { solidAdapter } from "@nifrajs/web-solid"
import solid from "vite-plugin-solid"
import { backend } from "./backend/app"

const routesDir = `${import.meta.dir}/routes`
const server = await createViteDevServer({
  root: import.meta.dir,
  routesDir,
  clientModule: "@nifrajs/web-solid/client",
  // `ssr: true` makes vite-plugin-solid emit *hydratable* client output (generate: "dom" +
  // hydratable) to match the server render - without it, Solid throws a hydration mismatch
  // ("Failed attempt to create new DOM elements during hydration").
  plugins: [solid({ ssr: true })],
  conditions: ["solid"],
  port: Number(Bun.env.PORT ?? 3000),
  createApp: (clientEntry, load) =>
    createWebApp({
      adapter: solidAdapter,
      manifest: discoverRoutes(routesDir, { load }),
      clientEntry,
      api: inProcessClient(backend),
      title: "nifra HMR (Solid, dev)",
    }),
})
console.log(`dev (HMR): http://localhost:${server.port}`)
