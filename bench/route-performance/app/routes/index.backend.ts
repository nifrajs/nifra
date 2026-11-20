import { t } from "@nifrajs/schema"
import { catalogItems } from "../../../ssr/shared/catalog.ts"

export const loaderOutput = t.object({
  items: t.array(t.object({ id: t.integer(), name: t.string() })),
})

export function loader() {
  return { items: catalogItems() }
}
