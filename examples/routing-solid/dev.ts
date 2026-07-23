/**
 * Dev server — the Bun pipeline: `Bun.serve` bundles and hot-reloads the client, Bun's runtime
 * resolves SSR, and no Vite is involved. `createDevServer` owns the SSR cache-busting, so no
 * `--watch` is needed:
 *
 *   bun --preload examples/routing-solid/ssr-preload.ts examples/routing-solid/dev.ts
 */
import { inProcessClient } from "@nifrajs/client"
import { createWebApp } from "@nifrajs/web"
import { createDevServer } from "@nifrajs/web/dev"
import { discoverRoutes } from "@nifrajs/web/fs"
import { solidAdapter, solidBunPlugin } from "@nifrajs/web-solid"
import { backend } from "./backend"

const routesDir = `${import.meta.dir}/routes`
const server = await createDevServer({
  routesDir,
  outDir: `${import.meta.dir}/dist`,
  clientModule: "@nifrajs/web-solid/client",
  plugins: [solidBunPlugin("dom")],
  conditions: ["bun", "solid", "browser"],
  port: Number(Bun.env.PORT ?? 3000),
  createApp: (clientEntry, importQuery) =>
    createWebApp({
      adapter: solidAdapter,
      manifest: discoverRoutes(routesDir, { importQuery }), // fresh route modules per rebuild
      clientEntry,
      api: inProcessClient(backend),
      title: "nifra F5 (Solid, dev)",
    }),
})
console.log(`dev: http://localhost:${server.port}`)
