/**
 * Type-level contract for a WebSocket route's `upgrade()`: it may refuse the handshake with
 * `status(...)`, as it may with a `Response`, and a refusal never becomes part of `ws.data`.
 * Verified by `tsc`, not run.
 */
import type { Equal, Expect } from "@nifrajs/test-utils"
import { server, status } from "../src/index.ts"
import { websocket } from "../src/ws.ts"

server()
  .use(websocket())
  .ws("/inferred", {
    upgrade: (c) =>
      c.req.headers.get("x-token") === "ok" ? { caller: "me" } : status(401, { error: "no" }),
    open: (ws) => {
      const data: Expect<Equal<typeof ws.data, { caller: string }>> = true
      void data
    },
  })
  .ws("/async", {
    upgrade: async (c) => (c.req.headers.get("x-token") === "ok" ? { caller: "me" } : status(503)),
    open: (ws) => {
      const data: Expect<Equal<typeof ws.data, { caller: string }>> = true
      void data
    },
  })
  .ws<{ caller: string }>("/explicit", {
    upgrade: (c) =>
      c.req.headers.get("x-token") === "ok" ? { caller: "me" } : status(403, { error: "full" }),
  })
  .ws<{ caller: string }>("/response", {
    upgrade: () => new Response("no", { status: 401 }),
  })
