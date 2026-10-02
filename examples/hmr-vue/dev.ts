/**
 * True-HMR dev server (Vue SFC) - the `@nifrajs/web/vite` server with Vue's official Vite plugin.
 *
 *   bun hmr-vue/dev.ts
 *   (containers/sandboxes: prefix CHOKIDAR_USEPOLLING=1)
 *
 * One compile pipeline for each `.vue`: `@vitejs/plugin-vue` compiles + HMRs the client, and compiles
 * the route modules `createApp`'s `load` resolves through Vite for SSR. Edit
 * `components/Counter.vue`'s <template> while the counter is non-zero - it updates live, count kept.
 */

import { inProcessClient } from "@nifrajs/client"
import { createWebApp } from "@nifrajs/web"
import { discoverRoutes } from "@nifrajs/web/fs"
import { createViteDevServer } from "@nifrajs/web/vite"
import { vueAdapter } from "@nifrajs/web-vue"
import vue from "@vitejs/plugin-vue"
import { backend } from "./backend/app"

const routesDir = `${import.meta.dir}/routes`
const server = await createViteDevServer({
  root: import.meta.dir,
  routesDir,
  clientModule: "@nifrajs/web-vue/client",
  plugins: [vue()],
  // Vue feature flags the plugin doesn't inject (mirrors the build's define).
  define: {
    __VUE_OPTIONS_API__: "true",
    __VUE_PROD_DEVTOOLS__: "false",
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
  },
  port: Number(Bun.env.PORT ?? 3000),
  createApp: (clientEntry, load) =>
    createWebApp({
      adapter: vueAdapter,
      manifest: discoverRoutes(routesDir, { load }),
      clientEntry,
      api: inProcessClient(backend),
      title: "nifra HMR (Vue, dev)",
    }),
})
console.log(`dev (HMR): http://localhost:${server.port}`)
