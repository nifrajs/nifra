import { catalogItems } from "$lib/catalog"

/** Per-request SSR — same workload as the nifra bench (no static cache). */
export function load() {
  return { items: catalogItems() }
}
