/**
 * Dev server — the Bun pipeline: `Bun.serve` bundles and hot-reloads the client, Bun's runtime
 * resolves SSR, and no Vite is involved. `createDevServer` owns the SSR cache-busting, so no
 * `--watch` is needed:
 *
 *   bun examples/routing-react/dev.ts        # React JSX is Bun-native — no preload
 */
import { inProcessClient } from "@nifrajs/client"
import { createWebApp } from "@nifrajs/web"
import { createDevServer } from "@nifrajs/web/dev"
import { discoverRoutes } from "@nifrajs/web/fs"
import { reactAdapter } from "@nifrajs/web-react"
import { backend } from "./backend"

const routesDir = `${import.meta.dir}/routes`
const server = await createDevServer({
  routesDir,
  outDir: `${import.meta.dir}/dist`,
  clientModule: "@nifrajs/web-react/client",
  conditions: ["bun", "browser"],
  define: { "process.env.NODE_ENV": '"development"' },
  port: Number(Bun.env.PORT ?? 3000),
  createApp: (clientEntry, importQuery) =>
    createWebApp({
      adapter: reactAdapter,
      manifest: discoverRoutes(routesDir, { importQuery }), // fresh route modules per rebuild
      clientEntry,
      api: inProcessClient(backend),
      title: "nifra F5 (React, dev)",
    }),
})
console.log(`dev: http://localhost:${server.port}`)
