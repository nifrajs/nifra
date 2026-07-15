import { server } from "@nifrajs/core/server"

// In-memory demo state — single-process example only (a real app would use a shared store).
let count = 0

/** The backend API (the contract source). The home route's loader/action call it in-process. */
export const backend = server()
  .get("/count", () => ({ count }))
  .post("/count", () => {
    count += 1
    return { count }
  })
