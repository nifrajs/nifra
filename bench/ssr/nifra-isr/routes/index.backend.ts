import { t } from "@nifrajs/schema"
import type { PageData } from "../../nifra/app.tsx"

// Long TTL so the oha window stays on cache hits after the runner's warmup (paired with next ISR).
export const revalidate = 3600

export const loaderOutput = t.object({
  items: t.array(t.object({ id: t.integer(), name: t.string() })),
})

export function loader(): PageData {
  return {
    items: Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: `Item ${i + 1}` })),
  }
}
