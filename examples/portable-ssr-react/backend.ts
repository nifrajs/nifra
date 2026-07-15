import { server } from "@nifrajs/core/server"

// In-memory demo state (per-process / per-isolate — a real app uses a shared store via c.env).
let count = 0

/** The backend API (the contract). The same app runs on five runtimes; only the entry differs. */
export const backend = server()
  .get("/users/:id", (c) => ({ id: c.params.id, name: `User #${c.params.id}` }))
  .get("/count", () => ({ count }))
  .post("/count", () => {
    count += 1
    return { count }
  })
