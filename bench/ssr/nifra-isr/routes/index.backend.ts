import type { PageData } from "../../nifra/app.tsx"

// Long TTL so the oha window stays on cache hits after the runner's warmup (paired with next ISR).
export const revalidate = 3600

export function loader(): PageData {
  return {
    items: Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: `Item ${i + 1}` })),
  }
}
