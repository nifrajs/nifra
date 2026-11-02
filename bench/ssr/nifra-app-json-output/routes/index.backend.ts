import { t } from "@nifrajs/schema"
import { catalogItems } from "../../shared/catalog.ts"

export const loaderOutput = t.json()

export function loader() {
  return { items: catalogItems() }
}
