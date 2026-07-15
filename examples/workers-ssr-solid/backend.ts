import { server } from "@nifrajs/core/server"

// In-memory demo state. NOTE: on Workers this lives per-isolate (not shared/durable) — a real edge
// app would use KV / Durable Objects / D1 (reached via `c.env`). Fine for a single-isolate demo.
let count = 0

/** The backend API (the contract source). Page loaders + actions call it via an in-process client. */
export const backend = server()
  .get("/users/:id", (c) => ({ id: c.params.id, name: `User #${c.params.id}` }))
  .get("/count", () => ({ count }))
  .post("/count", () => {
    count += 1
    return { count }
  })
