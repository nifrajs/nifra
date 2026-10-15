import { t } from "@nifrajs/schema"
import { catalogItems } from "../../shared/catalog.ts"

// Long TTL so the oha window stays on cache hits after the runner's warmup (paired with next ISR).
export const revalidate = 3600

export const loaderOutput = t.object({
  items: t.array(t.object({ id: t.integer(), name: t.string() })),
})

export function loader() {
  return { items: catalogItems() }
}
