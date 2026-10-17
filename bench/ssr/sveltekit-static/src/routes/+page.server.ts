import { catalogItems } from "#lib/catalog.js"

export function load() {
  return { items: catalogItems() }
}
