import { server } from "@nifrajs/core"

// Your backend contract — page loaders/actions call it in-process during SSR (no network). Replace
// the demo counter with real data (KV/D1/Postgres/…); on the edge, reach bindings via `c.env`.
let count = 0

export const backend = server()
  .get("/count", () => ({ count }))
  .post("/count", () => {
    count += 1
    return { count }
  })
