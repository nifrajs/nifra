import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { type Logger, server } from "../src/index.ts"
import { nodeDirect } from "../src/node-direct.ts"

const unrenderable = () => ({ n: 10n })

function loggerInto(sink: string[]): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error(message) {
      sink.push(message)
    },
  }
}

function harness() {
  const logged: string[] = []
  let finalized = 0
  const app = server({ logger: loggerInto(logged) })
    .onResponseFinalized(() => {
      finalized += 1
    })
    .get("/contextless", unrenderable)
    .get("/contextless-async", async () => ({ n: 10n }))
    .get("/context", (c) => {
      c.set.headers["x-bad"] = "a\r\nb"
      return { ok: true }
    })
    .get("/context-async", async (c) => ({ n: 10n, at: c.params }))
    .get("/query", { query: t.object({ a: t.optional(t.string()) }) }, () => ({ n: 10n }))
    .derive(() => ({ user: 1 }))
    .beforeHandle(() => undefined)
    .get("/lifecycle", unrenderable)
    .post("/lifecycle-body", { body: t.object({ a: t.number() }) }, () => ({ n: 10n }))
    .afterHandle((result) => result)
    .get("/lifecycle-after", unrenderable)
  return { app, logged, finalized: () => finalized }
}

const json = { "content-type": "application/json" }

const cases: ReadonlyArray<readonly [string, RequestInit?]> = [
  ["/contextless"],
  ["/contextless-async"],
  ["/context"],
  ["/context-async"],
  ["/query"],
  ["/lifecycle"],
  ["/lifecycle-body", { method: "POST", headers: json, body: '{"a":1}' }],
  ["/lifecycle-after"],
]

describe("a fused lane's render error", () => {
  for (const [path, init] of cases)
    test(`${path} is logged and answered 500, never thrown`, async () => {
      const { app, logged, finalized } = harness()
      let pending: Response | Promise<Response> | undefined
      expect(() => {
        pending = app.fetch(new Request(`http://x${path}`, init))
      }).not.toThrow()
      const response = await pending
      expect(response?.status).toBe(500)
      expect(await response?.json()).toEqual({ ok: false, error: "internal_error" })
      expect(logged).toEqual(["unhandled request error"])
      expect(finalized()).toBe(1)
    })

  test("a render after an async derive is logged and answered 500", async () => {
    const logged: string[] = []
    const app = server({ logger: loggerInto(logged) })
      .derive(async () => ({ user: 1 }))
      .beforeHandle(() => undefined)
      .get("/lifecycle", unrenderable)
    const response = await app.fetch(new Request("http://x/lifecycle"))
    expect(response.status).toBe(500)
    expect(logged).toEqual(["unhandled request error"])
  })

  test.each([
    ["/contextless"],
    ["/contextless-async"],
    ["/context-async"],
  ])("%s on the Node-direct lane is logged and answered 500", async (path) => {
    const logged: string[] = []
    const app = server({ logger: loggerInto(logged) })
      .use(nodeDirect())
      .get("/contextless", unrenderable)
      .get("/contextless-async", async () => ({ n: 10n }))
      .get("/context-async", async (c) => ({ n: 10n, at: c.params }))
    const outcome = await app.resolveNode(new Request(`http://x${path}`))
    expect(outcome.kind === "json" && outcome.status).toBe(500)
    expect(logged).toEqual(["unhandled request error"])
  })

  test("Bun's native route table answers it with the app's response headers", async () => {
    const logged: string[] = []
    const app = server({ logger: loggerInto(logged) })
      .responseHeaders({ "x-frame-options": "DENY" })
      .onResponse((response) => {
        response.headers.set("x-hook", "1")
        return response
      })
      .get("/contextless", unrenderable)
    const instance = app.listen(0, { hostname: "127.0.0.1" })
    try {
      const response = await fetch(`http://127.0.0.1:${instance.port}/contextless`)
      expect(response.status).toBe(500)
      expect(response.headers.get("x-frame-options")).toBe("DENY")
      expect(response.headers.get("x-hook")).toBe("1")
      expect(logged).toEqual(["unhandled request error"])
    } finally {
      instance.stop(true)
    }
  })
})
