import { parentPort } from "node:worker_threads"
import { server } from "@nifrajs/core"
import { serve } from "../../src/index.ts"

const running = await serve(
  server().get("/ping", () => ({ worker: true })),
  {
    port: 0,
    hostname: "127.0.0.1",
  },
)
parentPort?.postMessage({ port: running.port })
