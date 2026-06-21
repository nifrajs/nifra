/**
 * Svelte SSR renderer for the /frameworks build step. Svelte components compile from `.svelte` via the
 * compiler plugin, which (like Solid's) cannot share a `Bun.build` with the React/Preact `.tsx` builds.
 * build-frameworks.ts compiles this entry in an isolated `Bun.build` (with `svelteBunPlugin("ssr")`) and
 * imports the output. Renders the SAME catalog component the Svelte bench app + client entry use.
 */

import { svelteAdapter } from "@nifrajs/web-svelte"
import App from "../../bench/ssr/nifra-svelte/App.svelte"
import { type CatalogPageData, catalogItems } from "./data.ts"

const data: CatalogPageData = { items: catalogItems() }

/** The hydratable SSR markup for `#fw-stage` (matches the `[App]` client chain). */
export async function renderFragment(): Promise<string> {
  return String(await svelteAdapter.renderToString?.([App], { data }))
}

/** Svelte reconciles against the existing DOM on hydrate — no per-document bootstrap needed. */
export function hydrationHead(): string {
  return svelteAdapter.hydrationHead()
}
