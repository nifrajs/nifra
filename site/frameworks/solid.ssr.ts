/**
 * Solid SSR renderer for the /frameworks build step. Solid components are `.tsx` compiled by its Babel
 * plugin, whose loader filter matches EVERY `.tsx` — so it cannot share a `Bun.build` with React/Preact
 * `.tsx`. build-frameworks.ts compiles this entry in an isolated `Bun.build` (with `solidBunPlugin("ssr")`)
 * and imports the built output to obtain the fragment + the adapter's hydration head. Renders the SAME
 * catalog component the Solid bench app + the Solid client entry use.
 */

import { solidAdapter } from "@nifrajs/web-solid"
import { App } from "../../bench/ssr/nifra-solid/app.tsx"
import { type CatalogPageData, catalogItems } from "./data.ts"

const data: CatalogPageData = { items: catalogItems() }

/** The hydratable SSR markup for `#fw-stage` (matches the `[App]` client chain). */
export async function renderFragment(): Promise<string> {
  // `renderToString` is part of the seam as `string | Promise<string>`; await uniformly. Solid's is sync,
  // but normalizing to a Promise keeps the build orchestrator's per-framework call site identical.
  return String(await solidAdapter.renderToString?.([App], { data }))
}

/** Solid's per-document bootstrap (`generateHydrationScript()`) — the page injects it before loading
 * the Solid client bundle, which hydration requires. Empty for the other adapters. */
export function hydrationHead(): string {
  return solidAdapter.hydrationHead()
}
