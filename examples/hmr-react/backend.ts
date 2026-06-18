import { server } from "@nifrajs/core"

// In-memory demo state — single-process example only (see the global DB defaults for the real pattern).
let count = 0

/** Minimal contract for the HMR demo: a loader reads `message`, the action bumps `count`. */
export const backend = server()
  .get("/hello", () => ({ message: "rendered on the server" }))
  .get("/count", () => ({ count }))
  .post("/count", () => {
    count += 1
    return { count }
  })
