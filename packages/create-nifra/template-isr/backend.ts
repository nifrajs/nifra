import { server } from "@nifrajs/core"
import { t } from "@nifrajs/schema"

// Your backend contract — page loaders/actions call it in-process during SSR (no network). This demo
// counts server renders so the ISR cache is observable: a cache HIT serves stored bytes (the loader
// doesn't run, so the number holds), while a MISS or background REGENERATION runs it (it bumps).
// Replace it with real data (KV/D1/Postgres/…); on the edge, reach bindings via `c.env`.
let renders = 0

export const backend = server().get(
  "/page",
  { response: t.object({ renders: t.number() }) },
  () => {
    renders += 1
    return { renders }
  },
)
