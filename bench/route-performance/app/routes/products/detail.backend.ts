import { t } from "@nifrajs/schema"

export const loaderOutput = t.object({ name: t.string() })

export function loader() {
  return { name: "Product details" }
}
