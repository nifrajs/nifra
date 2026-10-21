/**
 * The bench app: the product page as blocking SSR (`/blocking/:id`), `defer()` streaming
 * (`/defer/:id`) and a partially prerendered route (`/ppr/:id`), for `FRAMEWORK` react or svelte.
 * `PPR_UPSTREAM` points the product read at the catalog process (S1); without it the page is tiny
 * (S0). `PPR_OPTIONS` (JSON) overrides partial prerendering's options.
 */
import { createCspPolicy, createWebApp, type RenderAdapter } from "@nifrajs/web"
import { discoverRoutes } from "@nifrajs/web/fs"
import { compileShells, partialPrerendering } from "@nifrajs/web/ppr"
import { svelteBunPlugin } from "@nifrajs/web-svelte/plugin"
import { plugin } from "bun"

const framework = process.env.FRAMEWORK === "svelte" ? "svelte" : "react"
const serverPlugins = framework === "svelte" ? [svelteBunPlugin("ssr")] : []
for (const serverPlugin of serverPlugins) plugin(serverPlugin)
const adapter: RenderAdapter =
  framework === "svelte"
    ? (await import("@nifrajs/web-svelte")).svelteAdapter
    : (await import("@nifrajs/web-react")).reactAdapter

const routesDir = `${import.meta.dir}/${framework}/routes`
const manifest = discoverRoutes(routesDir)
// No browser loads these pages, so the client entry is only a name: the deployment of every shell key.
const clientEntry = "/assets/entry-bench.js"
const shellChecks = await compileShells({
  routesDir,
  manifest,
  deployment: clientEntry,
  // The bench has no module that reads the visitor.
  requestScoped: () => false,
  plugins: serverPlugins,
  onFailure: (routeId, error) => {
    console.error(`shell check failed for ${routeId}:`, error)
    process.exit(1)
  },
})

export const app = createWebApp({
  adapter,
  manifest,
  clientEntry,
  csp: createCspPolicy({
    header: ({ sources }) => `script-src 'self' ${sources}; object-src 'none'; base-uri 'none'`,
  }),
  experimental: {
    ppr: partialPrerendering({
      shellChecks,
      origin: "https://shop.example",
      // A 0% hit rate at 128 connections builds a shell per request; the default of 4 builds per
      // route would render most of them whole instead.
      options: { shellBuildConcurrency: 1_024, ...JSON.parse(process.env.PPR_OPTIONS ?? "{}") },
    }),
  },
})
