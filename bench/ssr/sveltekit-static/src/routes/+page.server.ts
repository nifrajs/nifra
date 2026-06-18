import { catalogItems } from "$lib/catalog"

export function load() {
  return { items: catalogItems() }
}
