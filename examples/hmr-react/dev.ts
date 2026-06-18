/**
 * True-HMR dev server (React) — backed by Vite in middleware mode via `@nifrajs/web/vite`.
 *
 *   bun --preload examples/hmr-react/ssr-preload.ts examples/hmr-react/dev.ts
 *   CHOKIDAR_USEPOLLING=1 bun --preload examples/hmr-react/ssr-preload.ts examples/hmr-react/dev.ts  # sandboxes
 *
 * Vite serves + Fast-Refreshes the client modules (nifra's codegen'd entry + the route `.tsx`); nifra
 * still SSRs each request. Edit `components/Counter.tsx`'s <h1> while the counter is non-zero — the
 * heading updates live with the count PRESERVED (Fast Refresh, no reload). Editing `routes/index.tsx`
 * (it exports `loader`/`meta`, so it's not a refresh boundary) does a clean full reload instead.
 * Production stays Bun-native (`build.ts`).
 *
 * `.mdx` routes (see `routes/notes.mdx`) hot-reload too: @mdx-js/rollup compiles them for Vite's
 * client side (in `plugins`), and `ssr-preload.ts`'s `mdxBunPlugin` compiles them for nifra's Bun SSR.
 *
 * No `build.ts` here: in dev Vite resolves the route source directly (the `conditions: ["bun"]` in
 * createViteDevServer also routes `@nifrajs/web-react/*` to its TS source — no adapter build needed).
 */

import mdx from "@mdx-js/rollup"
import { inProcessClient } from "@nifrajs/client"
import { createWebApp } from "@nifrajs/web"
import { discoverRoutes } from "@nifrajs/web/fs"
import { createViteDevServer } from "@nifrajs/web/vite"
import { reactAdapter } from "@nifrajs/web-react"
import react from "@vitejs/plugin-react"
import { backend } from "./backend"

const routesDir = `${import.meta.dir}/routes`
const server = await createViteDevServer({
  root: import.meta.dir,
  routesDir,
  clientModule: "@nifrajs/web-react/client",
  // `.mdx` routes hot-reload in dev via @mdx-js/rollup (it sets enforce:"pre", running before react()).
  plugins: [mdx({ jsxImportSource: "react" }), react()],
  port: Number(Bun.env.PORT ?? 3000),
  createApp: (clientEntry, importQuery) =>
    createWebApp({
      adapter: reactAdapter,
      manifest: discoverRoutes(routesDir, { importQuery }), // fresh route modules for SSR per edit
      clientEntry,
      api: inProcessClient(backend),
      title: "nifra HMR (React, dev)",
    }),
})
console.log(`dev (HMR): http://localhost:${server.port}`)
