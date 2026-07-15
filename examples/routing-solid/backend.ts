import { server } from "@nifrajs/core/server"

// In-memory demo state — single-process example only, NOT a production pattern (a real app
// would use a shared store; see the global DB defaults).
let count = 0

/** The backend API (the contract source). Page loaders + actions call it via an in-process client. */
export const backend = server()
  .get("/users/:id", (c) => ({ id: c.params.id, name: `User #${c.params.id}` }))
  .get("/count", () => ({ count }))
  .post("/count", () => {
    count += 1
    return { count }
  })
