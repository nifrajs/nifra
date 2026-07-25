import { server } from "@nifrajs/core/server"
import { t } from "@nifrajs/schema"

// Replace the demo counter with real data (KV/D1/Postgres/…); on the edge, reach bindings via `c.env`.
// Anything this module can reach becomes reach for the routes below it, so give a feature that touches
// a database its own module rather than adding it here.
let count = 0

const Counter = t.object({ count: t.number() })

export const counter = server()
  .get("/count", { response: Counter }, () => ({ count }))
  .post("/count", { response: Counter }, () => {
    count += 1
    return { count }
  })
