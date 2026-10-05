import { server } from "@nifrajs/core/server"

let count = 0

export const backend = server()
  .get("/stats", () => ({
    pctOfRaw: 100,
    reqsPerSec: 118_000,
    adapters: 5,
    runtimes: 4,
  }))
  .get("/count", () => ({ count }))
  .post("/count", () => {
    count += 1
    return { count }
  })
