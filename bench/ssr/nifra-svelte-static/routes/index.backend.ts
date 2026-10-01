import { type CatalogPageData, catalogItems } from "../../shared/catalog.ts"
export const prerender = true

export function loader(): CatalogPageData {
  return { items: catalogItems() }
}
