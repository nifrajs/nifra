/**
 * True-HMR dev server (Preact) — same `@nifrajs/web/vite` server as the React example, with Preact's
 * official Vite plugin (`@preact/preset-vite`, which includes prefresh / Preact Fast Refresh).
 *
 *   bun examples/hmr-preact/dev.ts
 *   CHOKIDAR_USEPOLLING=1 bun examples/hmr-preact/dev.ts   # containers/sandboxes (no native fs events)
 *
 * Edit `components/Counter.tsx` while the counter is non-zero — the JSX updates live with the count
 * preserved (no reload). Production stays Bun-native.
 */

import { inProcessClient } from "@nifrajs/client"
import { createWebApp } from "@nifrajs/web"
import { discoverRoutes } from "@nifrajs/web/fs"
import { createViteDevServer } from "@nifrajs/web/vite"
import { preactAdapter } from "@nifrajs/web-preact"
import preact from "@preact/preset-vite"
import { backend } from "./backend"

const routesDir = `${import.meta.dir}/routes`
const server = await createViteDevServer({
  root: import.meta.dir,
  routesDir,
  clientModule: "@nifrajs/web-preact/client",
  plugins: [preact()],
  port: Number(Bun.env.PORT ?? 3000),
  createApp: (clientEntry, importQuery) =>
    createWebApp({
      adapter: preactAdapter,
      manifest: discoverRoutes(routesDir, { importQuery }),
      clientEntry,
      api: inProcessClient(backend),
      title: "nifra HMR (Preact, dev)",
    }),
})
console.log(`dev (HMR): http://localhost:${server.port}`)
