import { t } from "@nifrajs/schema"
import { type CatalogPageData, catalogItems } from "../../shared/catalog.ts"
export const prerender = true

export const loaderOutput = t.object({
  items: t.array(t.object({ id: t.integer(), name: t.string() })),
})

export function loader(): CatalogPageData {
  return { items: catalogItems() }
}
