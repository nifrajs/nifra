import { describe, expect, test } from "bun:test"
import { server, silentLogger } from "../src/index.ts"
import type { RawDerive } from "../src/internal/route-execution.ts"
import { compileRouteProgram } from "../src/internal/route-program.ts"
import { nodeDirect } from "../src/node-direct.ts"
import type { StandardResult, StandardSchemaV1, StandardTypes } from "../src/schema/standard.ts"

function schema<T>(
  validate: (value: unknown) => StandardResult<T> | Promise<StandardResult<T>>,
): StandardSchemaV1<unknown, T> {
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
  test("a synchronous auth-before-validation program stays synchronous", async () => {
    const order: string[] = []
    const app = server()
      .derive(() => {
        order.push("derive")
        return { principal: "reader" }
      })
      .beforeHandle(() => {
        order.push("before")
        return undefined
      })
      .afterHandle((value) => {
        order.push("after")
        return value
      })
      .get(
        "/policy",
        {
          validationOrder: "auth-before-validation",
          query: schema(() => {
            order.push("validate")
            return { value: { q: "checked" } }
          }),
        },
        (c) => {
          order.push("handler")
          return { principal: c.principal, q: c.query.q }
        },
      )
    const outcome = app.fetch(new Request("http://x/policy?q=input"))
    const synchronous = outcome instanceof Response
    const response = await outcome
    expect(await response.json()).toEqual({ principal: "reader", q: "checked" })
    expect(order).toEqual(["derive", "before", "validate", "handler", "after"])
    expect(synchronous).toBe(true)
  })

  for (const validationOrder of ["validate-before-auth", "auth-before-validation"] as const) {
    for (const boundary of ["none", "validation", "derive", "before", "handler", "after", "all"]) {
      test(`${validationOrder} resumes each stage exactly once after ${boundary} async boundaries on Web, Node, and Bun`, async () => {
        for (const transport of ["web", "node", "bun"]) {
          const order: string[] = []
          const pending = <T>(kind: string, value: T): T | Promise<T> =>
            boundary === "all" || boundary === kind ? Promise.resolve(value) : value
          const field = (kind: string, key: string) =>
            schema<Record<string, string>>((input) => {
              order.push(kind)
              const value =
                input !== null && typeof input === "object" ? Reflect.get(input, key) : undefined
              const result: StandardResult<Record<string, string>> =
                typeof value === "string"
                  ? { value: { [key]: value } }
                  : { issues: [{ message: `${key} required` }] }
              return pending("validation", result)
            })
          const app = server()
            .use(nodeDirect())
            .decorate("staticTag", "ready")
            .derive(() => {
              order.push("derive0")
              return pending("derive", { first: "a" })
            })
            .derive((c) => {
              order.push(`derive1:${c.first}`)
              return pending("derive", { second: "b" })
            })
            .beforeHandle((c) => {
              order.push("before0")
              c.set.headers["x-matrix"] = c.second
              return pending("before", undefined)
            })
            .beforeHandle(() => {
              order.push("before1")
              return pending("before", undefined)
            })
            .afterHandle((value) => {
              order.push("after0")
              return pending("after", { stage: 1, value })
            })
            .afterHandle((value) => {
              order.push("after1")
              return pending("after", { stage: 2, value })
            })
            .post(
              "/matrix/:id",
              {
                validationOrder,
                headers: field("headers", "x-token"),
                cookies: field("cookies", "sid"),
                params: field("params", "id"),
                body: field("body", "message"),
                query: field("query", "trace"),
              },
              (c) => {
                order.push("handler")
                return pending("handler", {
                  id: c.params.id,
                  message: c.body.message,
                  trace: c.query.trace,
                  sid: c.cookies.sid,
                  token: c.headers["x-token"],
                  first: c.first,
                  second: c.second,
                  staticTag: c.staticTag,
                })
              },
            )
          const expected = {
            stage: 2,
            value: {
              stage: 1,
              value: {
                id: "42",
                message: "hello",
                trace: "a b",
                sid: "session",
                token: "token",
                first: "a",
                second: "b",
                staticTag: "ready",
              },
            },
          }
          const init = {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-token": "token",
              cookie: "sid=session",
            },
            body: '{"message":"hello"}',
          }
          const path = "/matrix/42?trace=a%20b"
          if (transport === "node") {
            const result = await app.resolveNode(new Request(`http://x${path}`, init))
            expect(result.kind).toBe("json")
            if (result.kind !== "json") throw new Error("expected node JSON result")
            expect(result.status).toBe(200)
            expect(result.headers?.["x-matrix"]).toBe("b")
            expect(result.body).toBe(JSON.stringify(expected))
          } else {
            const running =
              transport === "bun" ? app.listen(0, { hostname: "127.0.0.1" }) : undefined
            try {
              const response =
                running === undefined
                  ? await app.fetch(new Request(`http://x${path}`, init))
                  : await fetch(`http://127.0.0.1:${running.port}${path}`, init)
              expect(response.status).toBe(200)
              expect(response.headers.get("x-matrix")).toBe("b")
              expect(await response.json()).toEqual(expected)
            } finally {
              running?.stop(true)
            }
          }
          const validationSteps = ["headers", "cookies", "params", "body", "query"]
          const policySteps = ["derive0", "derive1:a", "before0", "before1"]
          expect(order).toEqual([
            ...(validationOrder === "auth-before-validation"
              ? [...policySteps, ...validationSteps]
              : [...validationSteps, ...policySteps]),
            "handler",
            "after0",
            "after1",
          ])
        }
      })
    }
  }

  test("auth-before-validation rejects before invoking a body validator", async () => {
    let validations = 0
    const order: string[] = []
    const body = schema(() => {
      validations += 1
      return { issues: [{ message: "body rejected" }] }
    })
    const app = server()
      .derive(() => {
        order.push("derive")
        return { principal: "u1" }
      })
      .beforeHandle(() => {
        order.push("before")
        return new Response("forbidden", { status: 403 })
      })
      .post("/sensitive", { body, validationOrder: "auth-before-validation" }, () => ({
        shouldNotRun: true,
      }))

    const response = await app.fetch(
      new Request("http://x/sensitive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    )
    expect(response.status).toBe(403)
    expect(validations).toBe(0)
    expect(order).toEqual(["derive", "before"])
  })

  test("default validation order preserves 422-before-auth behavior", async () => {
    let validations = 0
    let beforeRuns = 0
    const body = schema(() => {
      validations += 1
      return { issues: [{ message: "body rejected" }] }
    })
    const app = server()
      .derive(() => ({ principal: "u1" }))
      .beforeHandle(() => {
        beforeRuns += 1
        return new Response("forbidden", { status: 403 })
      })
      .post("/sensitive", { body }, () => ({ shouldNotRun: true }))

    const response = await app.fetch(
      new Request("http://x/sensitive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    )
    expect(response.status).toBe(422)
    expect(validations).toBe(1)
    expect(beforeRuns).toBe(0)
  })

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
