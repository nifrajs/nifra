import { server } from "@nifrajs/core"

// In-memory demo state — single-process example only (see the global DB defaults for the real pattern).
let count = 0

/** Minimal contract: a loader reads `message`/`count`, the action bumps `count`. */
export const backend = server()
  .get("/hello", () => ({ message: "rendered on the server (Vue, via nifra dev)" }))
  .get("/count", () => ({ count }))
  .post("/count", () => {
    count += 1
    return { count }
  })
