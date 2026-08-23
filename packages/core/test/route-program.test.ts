import { describe, expect, test } from "bun:test"
import { server, silentLogger } from "../src/index.ts"
import type { RawDerive } from "../src/internal/route-execution.ts"
import { compileRouteProgram } from "../src/internal/route-program.ts"
import { nodeDirect } from "../src/node-direct.ts"
import type { StandardResult, StandardSchemaV1, StandardTypes } from "../src/schema/standard.ts"

function schema<T>(validate: (value: unknown) => StandardResult<T>): StandardSchemaV1<unknown, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "nifra-test",
      validate,
      types: undefined as unknown as StandardTypes<unknown, T>,
    },
  }
}

const stringRecord = (name: string): StandardSchemaV1<unknown, Record<string, string>> =>
  schema((value) => {
    const record = value as Record<string, unknown>
    return typeof value === "object" &&
      value !== null &&
      name in record &&
      typeof record[name] === "string"
      ? { value: record as Record<string, string> }
      : { issues: [{ message: `${name} is required` }] }
  })

describe("general route program", () => {
  test("freezes registration facts and snapshots route-local arrays", () => {
    const derive = () => ({ derived: true })
    const before = () => undefined
    const after = (value: unknown) => value
    const derives: RawDerive[] = [derive]
    const beforeHandle = [before]
    const afterHandle = [after]
    const decorations: Record<string, unknown> = { version: 1 }
    const program = compileRouteProgram({
      schema: { query: stringRecord("q") },
      handler: () => ({ ok: true }),
      derives,
      beforeHandle,
      afterHandle,
      onError: [],
      decorations,
      hasDecorations: true,
      bodySchema: undefined,
      bodyLimit: 1024,
      responseContract: undefined,
    })

    derives.push(() => ({ later: true }))
    beforeHandle.push(() => undefined)
    decorations.version = 2

    expect(Object.isFrozen(program)).toBe(true)
    expect(Object.isFrozen(program.stages)).toBe(true)
    expect(Object.isFrozen(program.derives)).toBe(true)
    expect(program.stages.map((stage) => stage.kind)).toEqual([
      "query",
      "derive",
      "before",
      "handler",
      "after",
    ])
    expect(program.derives).toHaveLength(1)
    expect(program.beforeHandle).toHaveLength(1)
    expect(program.decorations.version).toBe(1)
  })

  test("runs all registered validation stages and lifecycle hooks in order", async () => {
    const order: string[] = []
    const app = server()
      .derive(() => {
        order.push("derive")
        return { role: "admin" }
      })
      .beforeHandle((ctx) => {
        order.push(`before:${ctx.role}`)
        return undefined
      })
      .afterHandle((value) => {
        order.push("after")
        return { value }
      })
      .get(
        "/users/:id",
        {
          headers: stringRecord("x-token"),
          params: stringRecord("id"),
          query: stringRecord("q"),
        },
        (ctx) => {
          order.push("handler")
          return { id: ctx.params.id, q: ctx.query.q, token: ctx.headers["x-token"] }
        },
      )

    const response = await app.fetch(
      new Request("http://x/users/42?q=ada", { headers: { "x-token": "test" } }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      value: { id: "42", q: "ada", token: "test" },
    })
    expect(order).toEqual(["derive", "before:admin", "handler", "after"])
  })

  test("keeps errors redacted and thrown Responses as control flow", async () => {
    const unauthorized = server({ logger: silentLogger })
      .derive(() => {
        throw new Response(null, { status: 401 })
      })
      .get("/unauthorized", () => ({ shouldNotRun: true }))
    const app = server({ logger: silentLogger })
      .derive(() => {
        throw new Error("private detail")
      })
      .get("/error", () => ({ shouldNotRun: true }))

    expect((await unauthorized.fetch(new Request("http://x/unauthorized"))).status).toBe(401)
    const error = await app.fetch(new Request("http://x/error"))
    expect(error.status).toBe(500)
    expect(await error.text()).not.toContain("private detail")
  })

  test("uses the same finalization ABI for Web and Node-direct outcomes", async () => {
    const app = server()
      .use(nodeDirect())
      .derive(() => ({ requestId: "req-1" }))
      .beforeHandle((ctx) => {
        ctx.set.headers["x-program"] = "yes"
        return undefined
      })
      .afterHandle((value) => value)
      .get("/final", (ctx) => ({ ok: true, requestId: ctx.requestId }))

    const request = () => new Request("http://x/final")
    const web = await app.fetch(request())
    const node = await app.resolveNode(request())
    expect(web.status).toBe(200)
    expect(web.headers.get("x-program")).toBe("yes")
    expect(await web.text()).toBe(JSON.stringify({ ok: true, requestId: "req-1" }))
    expect(node.kind).toBe("json")
    if (node.kind !== "json") throw new Error("unreachable")
    expect(node.status).toBe(web.status)
    expect(node.headers?.["x-program"]).toBe("yes")
    expect(node.body).toBe(JSON.stringify({ ok: true, requestId: "req-1" }))
  })
})
