import { t } from "@nifrajs/schema"
import type { Route } from "./+types/index"

// ISR: the `withISR` wrapper (worker.ts / server.ts) caches this page and serves it
// stale-while-revalidate. `revalidate` is the freshness window in SECONDS - nifra emits it as the
// `x-nifra-isr-revalidate` header, which the wrapper reads to set this page's TTL.
export const revalidate = 10

export const loaderOutput = t.object({ renders: t.number(), revalidate: t.number() })

export async function loader({ api }: Route.LoaderArgs) {
  const res = await api.page.get()
  return { renders: res.ok ? res.data.renders : 0, revalidate }
}
