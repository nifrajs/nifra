/**
 * True-HMR dev server (Svelte) — the `@nifrajs/web/vite` server with `@sveltejs/vite-plugin-svelte`
 * (Svelte 5's built-in HMR for the client). `svelteBunPlugin("ssr")` (preloaded, see ssr-preload.ts)
 * handles the Bun-side SSR compile.
 *
 *   bun --preload hmr-svelte/ssr-preload.ts hmr-svelte/dev.ts
 *   (containers/sandboxes: prefix CHOKIDAR_USEPOLLING=1)
 *
 * Edit `components/Counter.svelte` while the counter is non-zero — it updates live, count preserved.
 */

import { inProcessClient } from "@nifrajs/client"
import { createWebApp } from "@nifrajs/web"
import { discoverRoutes } from "@nifrajs/web/fs"
import { createViteDevServer } from "@nifrajs/web/vite"
import { svelteAdapter } from "@nifrajs/web-svelte"
import { svelte } from "@sveltejs/vite-plugin-svelte"
import { backend } from "./backend"

const routesDir = `${import.meta.dir}/routes`
const server = await createViteDevServer({
  root: import.meta.dir,
  routesDir,
  clientModule: "@nifrajs/web-svelte/client",
  plugins: [svelte()],
  port: Number(Bun.env.PORT ?? 3000),
  createApp: (clientEntry, importQuery) =>
    createWebApp({
      adapter: svelteAdapter,
      manifest: discoverRoutes(routesDir, { importQuery }),
      clientEntry,
      api: inProcessClient(backend),
      title: "nifra HMR (Svelte, dev)",
    }),
})
console.log(`dev (HMR): http://localhost:${server.port}`)
