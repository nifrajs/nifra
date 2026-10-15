/**
 * Vue SSR renderer for the /frameworks build step. The Vue catalog component is an SFC that compiles
 * from `.vue` via the compiler plugin, so build-frameworks.ts compiles this entry in an isolated
 * `Bun.build` (with `vueBunPlugin("ssr")`) and imports the output. Renders the SAME catalog component
 * the Vue bench rows + client entry use.
 */

import { vueAdapter } from "@nifrajs/web-vue"
import App from "../../bench/ssr/nifra-vue/App.vue"
import { type CatalogPageData, catalogItems } from "../shared/frameworks/data.ts"

const data: CatalogPageData = { items: catalogItems() }

/** The hydratable SSR markup for `#fw-stage` (matches the `[App]` client chain). */
export async function renderFragment(): Promise<string> {
  return String(await vueAdapter.renderToString?.([App], { data }))
}

/** Vue reconciles against the existing DOM on hydrate - no per-document bootstrap needed. */
export function hydrationHead(): string {
  return vueAdapter.hydrationHead()
}
