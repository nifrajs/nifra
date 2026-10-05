import { t } from "@nifrajs/schema"
import type { Route } from "./+types/index"

// ISR: the `withISR` wrapper (server.ts / worker.ts) caches this page's rendered document and serves
// it stale-while-revalidate. `revalidate` is the freshness window in **seconds** - `createWebApp`
// emits it as the `x-nifra-isr-revalidate` response header, which the wrapper reads to set this page's
// TTL (overriding the wrapper default). 2s keeps the demo snappy.
export const revalidate = 2

export const loaderOutput = t.object({ renders: t.number() })

export async function loader({ api }: Route.LoaderArgs) {
  const res = await api.page.get()
  return { renders: res.ok ? res.data.renders : 0 }
}
