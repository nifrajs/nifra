import { server } from "@nifrajs/core"
import { t } from "@nifrajs/schema"

// Your backend contract — page loaders/actions call it in-process during SSR (no network). Replace
// the demo counter with real data (KV/D1/Postgres/…); on the edge, reach bindings via `c.env`.
let count = 0

const Counter = t.object({ count: t.number() })

export const backend = server()
  .get("/count", { response: Counter }, () => ({ count }))
  .post("/count", { response: Counter }, () => {
    count += 1
    return { count }
  })
