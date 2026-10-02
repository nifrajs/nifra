/**
 * True-HMR dev server (Svelte) - the `@nifrajs/web/vite` server with `@sveltejs/vite-plugin-svelte`
 * (Svelte 5's built-in HMR for the client). The same plugin compiles route modules for SSR:
 * `createApp`'s `load` resolves them through Vite, so a server render reflects the latest edit.
 *
 *   bun hmr-svelte/dev.ts
 *   (containers/sandboxes: prefix CHOKIDAR_USEPOLLING=1)
 *
 * Edit `components/Counter.svelte` - it updates live, no page reload. (Svelte's own HMR recreates the
 * component, so its `$state` count restarts at 0; the rest of the page is untouched.)
 */

import { inProcessClient } from "@nifrajs/client"
import { createWebApp } from "@nifrajs/web"
import { discoverRoutes } from "@nifrajs/web/fs"
import { createViteDevServer } from "@nifrajs/web/vite"
import { svelteAdapter } from "@nifrajs/web-svelte"
import { svelteHmrBoundary } from "@nifrajs/web-svelte/plugin"
import { svelte } from "@sveltejs/vite-plugin-svelte"
import { backend } from "./backend/app"

const routesDir = `${import.meta.dir}/routes`
const server = await createViteDevServer({
  root: import.meta.dir,
  routesDir,
  clientModule: "@nifrajs/web-svelte/client",
  // `svelteHmrBoundary` keeps the hot-patch wrapper on the app's own views and off the layout chain,
  // where it would desync hydration on first load. See its doc comment.
  plugins: [svelte({ dynamicCompileOptions: svelteHmrBoundary })],
  port: Number(Bun.env.PORT ?? 3000),
  createApp: (clientEntry, load) =>
    createWebApp({
      adapter: svelteAdapter,
      manifest: discoverRoutes(routesDir, { load }),
      clientEntry,
      api: inProcessClient(backend),
      title: "nifra HMR (Svelte, dev)",
    }),
})
console.log(`dev (HMR): http://localhost:${server.port}`)
