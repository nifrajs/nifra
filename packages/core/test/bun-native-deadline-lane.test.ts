import { expect, test } from "bun:test"
import { NIFRA_DEADLINE_HEADER } from "../src/budget.ts"
import { server, silentLogger } from "../src/index.ts"
import { responseObserver } from "../src/response-observer.ts"

/** A value `JSON.stringify` throws on. */
function cyclic(): Record<string, unknown> {
  const node: Record<string, unknown> = {}
  node.self = node
  return node
}

/**
 * With `acceptInboundDeadlines`, a route in Bun's native table answers a request that carries no
 * deadline on the table's own lane. That lane must still run the header-only response hooks the
 * table admits, as it does without the option, on a render that fails as on one that succeeds.
 */
test("a header-only response hook runs on every lane of the table under acceptInboundDeadlines", async () => {
  const app = server({ acceptInboundDeadlines: true, logger: silentLogger })
    .use(responseObserver())
    .onResponseHeaders((headers) => {
      headers.set("x-observed", "1")
    })
    .get("/static", () => ({ ok: true }))
    .get("/users/:id", (c) => ({ id: c.params.id }))
    .get("/unrenderable", () => ({ count: cyclic() }))
  const running = app.listen(0, { hostname: "127.0.0.1" })
  const deadline = { headers: { [NIFRA_DEADLINE_HEADER]: String(Date.now() + 60_000) } }
  try {
    for (const [path, init, status] of [
      ["/static", undefined, 200],
      ["/users/7", undefined, 200],
      ["/unrenderable", undefined, 500],
      ["/static", deadline, 200],
      ["/users/7", deadline, 200],
    ] satisfies [string, RequestInit | undefined, number][]) {
      const response = await fetch(`http://127.0.0.1:${running.port}${path}`, init)
      expect(response.status).toBe(status)
      expect(`${path} ${response.headers.get("x-observed")}`).toBe(`${path} 1`)
      await response.arrayBuffer()
    }
  } finally {
    running.stop(true)
  }
})
