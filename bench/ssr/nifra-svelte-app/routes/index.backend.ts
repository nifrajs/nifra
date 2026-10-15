import { t } from "@nifrajs/schema"
import { catalogItems } from "../../shared/catalog.ts"

export const loaderOutput = t.object({
  items: t.array(t.object({ id: t.integer(), name: t.string() })),
})

export function loader() {
  return { items: catalogItems() }
}
