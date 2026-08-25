import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { executeCapability } from "../src/capabilities.ts"
import { effectLedger } from "../src/effect-ledger.ts"
import { server, silentLogger } from "../src/index.ts"
import { createMemoryLedgerSink } from "../src/ledger.ts"
import { nodeDirect } from "../src/node-direct.ts"
import type { StandardSchemaV1 } from "../src/schema/standard.ts"

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://test${path}`, init)
}

describe("fused lifecycle lanes", () => {
  test("query validation runs before derive and beforeHandle", async () => {
    const order: string[] = []
    const app = server()
      .derive(() => {
        order.push("derive")
        return { user: "ada" }
      })
      .beforeHandle(() => {
        order.push("before")
      })
      .get("/search", { query: t.object({ q: t.string() }) }, (c) => {
        order.push("handler")
        return { q: c.query.q, user: c.user }
      })

    const response = app.fetch(request("/search?q=typed"))
    expect(response).toBeInstanceOf(Response)
    expect(await (response as Response).json()).toEqual({ q: "typed", user: "ada" })
    expect(order).toEqual(["derive", "before", "handler"])
  })

  test("body validation and afterHandle stay in the fused lifecycle order", async () => {
    const order: string[] = []
    const app = server()
      .derive(() => {
        order.push("derive")
        return { user: "ada" }
      })
      .beforeHandle(() => {
        order.push("before")
      })
      .afterHandle((result) => {
        order.push("after")
        return { result }
      })
      .post("/users", { body: t.object({ name: t.string() }) }, (c) => {
        order.push("handler")
        return { name: c.body.name, user: c.user }
      })

    const response = await app.fetch(
      request("/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      }),
    )
    expect(await response.json()).toEqual({
      result: { name: "Ada", user: "ada" },
    })
    expect(order).toEqual(["derive", "before", "handler", "after"])
  })

  test("async derive, beforeHandle, handler, and afterHandle use the same continuation", async () => {
    const app = server()
      .derive(async () => {
        await Promise.resolve()
        return { user: "ada" }
      })
      .beforeHandle(async (c) => {
        await Promise.resolve()
        c.set.headers["x-before"] = "1"
      })
      .afterHandle(async (result) => {
        await Promise.resolve()
        return { result, after: true }
      })
      .get("/async", async (c) => {
        await Promise.resolve()
        return { user: c.user }
      })

    const response = await app.fetch(request("/async"))
    expect(response.headers.get("x-before")).toBe("1")
    expect(await response.json()).toEqual({ result: { user: "ada" }, after: true })
  })

  test("validation recovery is not bypassed by lifecycle specialization", async () => {
    const app = server()
      .derive(() => ({ user: "ada" }))
      .beforeHandle(() => undefined)
      .get(
        "/recover",
        {
          query: t.object({ q: t.string() }),
          onValidationError: () => ({ q: "fallback" }),
        },
        (c) => ({ q: c.query.q, user: c.user }),
      )

    const response = await app.fetch(request("/recover"))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ q: "fallback", user: "ada" })
  })

  test("around hooks are not bypassed by lifecycle specialization", async () => {
    const order: string[] = []
    const app = server()
      .derive(() => ({ user: "ada" }))
      .beforeHandle(() => undefined)
      .around((_ctx, next) => {
        order.push("around")
        return next()
      })
      .get("/wrapped", (c) => ({ user: c.user }))

    expect(await (await app.fetch(request("/wrapped"))).json()).toEqual({ user: "ada" })
    expect(order).toEqual(["around"])
  })

  test("effect-ledger routes keep ledger attachment and settlement", async () => {
    const memory = createMemoryLedgerSink()
    const app = server({ logger: silentLogger })
      .use(effectLedger({ sink: memory.sink }))
      .derive(() => ({ user: "ada" }))
      .beforeHandle(() => undefined)
      .post("/pay", { capabilities: ["payments.charge"] }, async (c) => {
        return executeCapability(c, "payments.charge", {}, async () => ({ ok: true }))
      })

    const response = await app.fetch(request("/pay", { method: "POST" }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(memory.ledgers[0]?.entries.map((entry) => entry.phase)).toEqual(["intent", "committed"])
  })

  test("merge keeps body lifecycle stages on the Node-direct path", async () => {
    const feature = server()
      .derive(() => ({ user: "ada" }))
      .beforeHandle(() => undefined)
      .afterHandle((result) => ({ result, after: true }))
      .post("/merged", { body: t.object({ name: t.string() }) }, (c) => ({
        name: c.body.name,
        user: c.user,
      }))
    const app = server().use(nodeDirect()).merge(feature)

    const outcome = await app.resolveNode(
      request("/merged", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      }),
    )
    expect(outcome.kind).toBe("json")
    if (outcome.kind !== "json") throw new Error("expected a JSON node outcome")
    expect(JSON.parse(outcome.body ?? "null")).toEqual({
      result: { name: "Ada", user: "ada" },
      after: true,
    })
  })

  test("fused lifecycle errors still become the flat internal-error response", async () => {
    const deriveError = server({ logger: silentLogger })
      .derive(() => {
        throw new Error("derive failed")
      })
      .beforeHandle(() => undefined)
      .get("/derive-error", () => ({ ok: true }))
    const afterError = server({ logger: silentLogger })
      .derive(() => ({ user: "ada" }))
      .beforeHandle(() => undefined)
      .afterHandle(() => {
        throw new Error("after failed")
      })
      .get("/after-error", () => ({ ok: true }))
    const bodyError = server({ logger: silentLogger })
      .derive(() => ({ user: "ada" }))
      .beforeHandle(() => undefined)
      .post("/body-error", { body: t.object({ name: t.string() }) }, () => {
        throw new Error("handler failed")
      })

    for (const [app, path, init] of [
      [deriveError, "/derive-error", undefined],
      [afterError, "/after-error", undefined],
      [
        bodyError,
        "/body-error",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Ada" }),
        },
      ],
    ] as const) {
      const response = await app.fetch(request(path, init))
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ ok: false, error: "internal_error" })
    }
  })

  test("async validation and after continuations stay on the fused lanes", async () => {
    const invalidQuery: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async () => ({ issues: [{ message: "q is required" }] }),
      },
    }
    const invalidBody: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async () => ({ issues: [{ message: "name is required" }] }),
      },
    }
    const queryApp = server({ logger: silentLogger })
      .derive(() => ({ user: "ada" }))
      .beforeHandle(() => undefined)
      .afterHandle((result) => ({ result }))
      .get("/async-invalid-query", { query: invalidQuery }, () => ({ ok: true }))
    const bodyApp = server({ logger: silentLogger })
      .derive(() => ({ user: "ada" }))
      .beforeHandle(() => undefined)
      .post("/async-invalid-body", { body: invalidBody }, () => ({ ok: true }))
    const asyncAfterApp = server()
      .derive(() => ({ user: "ada" }))
      .beforeHandle(() => undefined)
      .afterHandle(async (result) => ({ result, after: await Promise.resolve(true) }))
      .post("/async-after", { body: t.object({ name: t.string() }) }, (c) => ({
        name: c.body.name,
      }))

    const queryResponse = await queryApp.fetch(request("/async-invalid-query"))
    expect(queryResponse.status).toBe(422)

    const bodyResponse = await bodyApp.fetch(
      request("/async-invalid-body", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      }),
    )
    expect(bodyResponse.status).toBe(422)

    const afterResponse = await asyncAfterApp.fetch(
      request("/async-after", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      }),
    )
    expect(await afterResponse.json()).toEqual({ result: { name: "Ada" }, after: true })
  })
})
