import { expect, test } from "bun:test"
import { NIFRA_DEADLINE_HEADER } from "../src/budget.ts"
import { server, silentLogger } from "../src/index.ts"
import { nodeDirect } from "../src/node-direct.ts"
import { responseObserver } from "../src/response-observer.ts"
import type { StandardSchemaV1 } from "../src/schema/standard.ts"
import { responseContract } from "../src/server/response-contract-lane.ts"

const namedBody: StandardSchemaV1<unknown, { name: string }> = {
  "~standard": {
    version: 1,
    vendor: "native-program-test",
    validate(value) {
      return value !== null &&
        typeof value === "object" &&
        "name" in value &&
        typeof value.name === "string"
        ? { value: { name: value.name } }
        : { issues: [{ message: "name required" }] }
    },
  },
}

for (const validationOrder of ["validate-before-auth", "auth-before-validation"] as const) {
  test(`native general plans preserve ${validationOrder}, errors, recovery, and body security`, async () => {
    let observations = 0
    let aroundCalls = 0
    const app = server({ maxBodyBytes: 128, logger: silentLogger })
      .use(responseObserver())
      .onResponseHeaders((headers) => {
        observations += 1
        headers.set("x-observed", "yes")
      })
      .use({
        around(_c, next) {
          aroundCalls += 1
          return next()
        },
      })
      .decorate("tag", "decorated")
      .derive(() => ({ role: "reader" }))
      .beforeHandle((c) => {
        if (c.header("x-block") === "1") return new Response("blocked", { status: 403 })
        if (c.header("x-throw") === "response") throw new Response("intentional", { status: 418 })
        if (c.header("x-throw") === "error") throw new Error("private detail")
        return undefined
      })
      .beforeHandle(() => undefined)
      .afterHandle((value, c) => {
        c.set.headers["x-after"] = "yes"
        return value
      })
      .onError(() => new Response("mapped", { status: 409 }))
      .post("/protected/:id", { body: namedBody, validationOrder }, (c) => ({
        id: c.params.id,
        name: c.body.name,
        role: c.role,
        tag: c.tag,
      }))
      .post(
        "/recover",
        {
          body: namedBody,
          onValidationError: async () => new Response("recovered", { status: 418 }),
        },
        (c) => ({ name: c.body.name }),
      )
      .post("/raw", async (c) => ({ text: await c.req.text() }))

    const cases: {
      path: string
      body: string
      status: number
      headers?: Record<string, string>
    }[] = [
      { path: "/protected/42", body: '{"name":"Ada"}', status: 200 },
      { path: "/protected/42", body: '{"name":"Ada","__proto__":{"admin":true}}', status: 400 },
      {
        path: "/protected/42",
        body: '{"name":"Ada","constructor":{"prototype":{"admin":true}}}',
        status: 400,
      },
      { path: "/protected/42", body: JSON.stringify({ name: "x".repeat(256) }), status: 413 },
      { path: "/protected/42", body: '{"name":42}', status: 422 },
      {
        path: "/protected/42",
        body: "{",
        headers: { "x-block": "1" },
        status: validationOrder === "auth-before-validation" ? 403 : 400,
      },
      {
        path: "/protected/42",
        body: '{"name":"Ada"}',
        headers: { "x-throw": "response" },
        status: 418,
      },
      {
        path: "/protected/42",
        body: '{"name":"Ada"}',
        headers: { "x-throw": "error" },
        status: 409,
      },
      { path: "/recover", body: "{}", status: 418 },
      { path: "/raw", body: "x".repeat(256), status: 413 },
    ]
    const running = app.listen(0, { hostname: "127.0.0.1" })
    try {
      for (const probe of cases) {
        const init = {
          method: "POST",
          headers: { "content-type": "application/json", ...probe.headers },
          body: probe.body,
        }
        const portable = await app.fetch(new Request(`http://x${probe.path}`, init))
        const native = await fetch(`http://127.0.0.1:${running.port}${probe.path}`, init)
        expect(portable.status).toBe(probe.status)
        expect(native.status).toBe(probe.status)
        expect(native.headers.get("x-observed")).toBe("yes")
        expect(native.headers.get("x-after")).toBe(portable.headers.get("x-after"))
        const text = await native.text()
        expect(text).toBe(await portable.text())
        expect(text).not.toContain("private detail")
      }
      expect(observations).toBe(cases.length * 2)
      expect(aroundCalls).toBe(cases.length * 2)
    } finally {
      running.stop(true)
    }
  })
}

for (const validationOrder of ["validate-before-auth", "auth-before-validation"] as const) {
  test(`body continuations preserve ${validationOrder} error boundaries`, async () => {
    for (const failure of [
      "validator",
      "async-validator",
      "handler",
      "async-handler",
      "after",
      "render",
      "response",
    ]) {
      let errors = 0
      const body: StandardSchemaV1 = {
        "~standard": {
          version: 1,
          vendor: "continuation-test",
          validate(value) {
            if (failure === "validator") throw new Error("private validation detail")
            if (failure === "async-validator")
              return Promise.reject(new Error("private validation detail"))
            return { value }
          },
        },
      }
      const app = server({ logger: silentLogger })
        .use(nodeDirect())
        .beforeHandle(() => undefined)
        .beforeHandle(() => undefined)
        .afterHandle((value) => {
          if (failure === "after") throw new Error("private after detail")
          return value
        })
        .onError(() => {
          errors += 1
          return new Response("mapped", { status: 409 })
        })
        .post("/failure", { body, validationOrder }, () => {
          if (failure === "handler") throw new Error("private handler detail")
          if (failure === "async-handler")
            return Promise.reject(new Error("private handler detail"))
          if (failure === "response") throw new Response("intentional", { status: 418 })
          const value: { self?: unknown } = {}
          if (failure === "render") value.self = value
          return value
        })
      const running = app.listen(0, { hostname: "127.0.0.1" })
      const expectedStatus = failure === "response" ? 418 : 409
      const init = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
      try {
        for (const transport of ["web", "node", "bun"]) {
          const response =
            transport === "node"
              ? await app.resolveNode(new Request("http://x/failure", init))
              : transport === "web"
                ? await app.fetch(new Request("http://x/failure", init))
                : await fetch(`http://127.0.0.1:${running.port}/failure`, init)
          if (response instanceof Response) {
            expect(response.status).toBe(expectedStatus)
            expect(await response.text()).toBe(failure === "response" ? "intentional" : "mapped")
          } else {
            expect(response.kind).toBe("response")
            if (response.kind !== "response") throw new Error("expected mapped response")
            expect(response.response.status).toBe(expectedStatus)
            expect(await response.response.text()).toBe(
              failure === "response" ? "intentional" : "mapped",
            )
          }
        }
        expect(errors).toBe(failure === "response" ? 0 : 3)
      } finally {
        running.stop(true)
      }
    }
  })

  test(`an async response contract's render failure reaches onError under ${validationOrder}`, async () => {
    type Rendered = { id: string; count: bigint }
    const isRendered = (value: unknown): value is Rendered =>
      typeof value === "object" && value !== null && "id" in value && "count" in value
    const response: StandardSchemaV1<Rendered, Rendered> = {
      "~standard": {
        version: 1,
        vendor: "continuation-test",
        validate: (value) =>
          Promise.resolve(
            isRendered(value) ? { value } : { issues: [{ message: "not rendered" }] },
          ),
      },
    }
    for (const handlerAsync of [false, true]) {
      let errors = 0
      const app = server({ logger: silentLogger })
        .use(nodeDirect())
        .use(responseContract("enforce"))
        .beforeHandle(() => undefined)
        .beforeHandle(() => undefined)
        .onError(() => {
          errors += 1
          return new Response("mapped", { status: 409 })
        })
        .get("/render", { response, validationOrder }, () => {
          const value: Rendered = { id: "u1", count: 1n }
          return handlerAsync ? Promise.resolve(value) : value
        })
      const running = app.listen(0, { hostname: "127.0.0.1" })
      try {
        for (const transport of ["web", "node", "bun"]) {
          const outcome =
            transport === "node"
              ? await app.resolveNode(new Request("http://x/render"))
              : transport === "web"
                ? await app.fetch(new Request("http://x/render"))
                : await fetch(`http://127.0.0.1:${running.port}/render`)
          let answered: Response
          if (outcome instanceof Response) answered = outcome
          else if (outcome.kind === "response") answered = outcome.response
          else throw new Error(`expected a Response, got a ${outcome.kind} outcome`)
          expect(answered.status).toBe(409)
          expect(await answered.text()).toBe("mapped")
        }
        expect(errors).toBe(3)
      } finally {
        running.stop(true)
      }
    }
  })
}

test("native general plans fall back for inbound deadlines without response hooks", async () => {
  let handlers = 0
  const app = server({ acceptInboundDeadlines: true, logger: silentLogger })
    .beforeHandle(() => undefined)
    .beforeHandle(() => undefined)
    .get("/native-budget/:id", (c) => {
      handlers += 1
      return { id: c.params.id, bounded: Number.isFinite(c.budget.remaining()) }
    })
  const running = app.listen(0, { hostname: "127.0.0.1" })
  try {
    for (const [deadline, status] of [
      [undefined, 200],
      [String(Date.now() + 60_000), 200],
      ["bad", 400],
      [String(Date.now() - 5_000), 408],
    ] satisfies [string | undefined, number][]) {
      const response = await fetch(`http://127.0.0.1:${running.port}/native-budget/42`, {
        headers: deadline === undefined ? {} : { [NIFRA_DEADLINE_HEADER]: deadline },
      })
      expect(response.status).toBe(status)
      if (status === 200)
        expect(await response.json()).toEqual({ id: "42", bounded: deadline !== undefined })
      else await response.arrayBuffer()
    }
    expect(handlers).toBe(2)
  } finally {
    running.stop(true)
  }
})

test("native general plans cannot skip capacity admission", async () => {
  let admissions = 0
  let hooks = 0
  let handlers = 0
  const app = server({
    logger: silentLogger,
    admission: {
      admit() {
        admissions += 1
        return { admitted: false, response: new Response("busy", { status: 429 }) }
      },
    },
  })
    .beforeHandle(() => {
      hooks += 1
      return undefined
    })
    .beforeHandle(() => undefined)
    .get("/capacity/:id", () => {
      handlers += 1
      return "wrong"
    })
  const running = app.listen(0, { hostname: "127.0.0.1" })
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/capacity/42`)
    expect(response.status).toBe(429)
    expect(await response.text()).toBe("busy")
    expect(admissions).toBe(1)
    expect(hooks).toBe(0)
    expect(handlers).toBe(0)
  } finally {
    running.stop(true)
  }
})

test("native general plans retain deadline admission and finalized response hooks", async () => {
  let finalized = 0
  const app = server({ acceptInboundDeadlines: true, logger: silentLogger })
    .use(responseObserver())
    .onResponseFinalized(() => {
      finalized += 1
    })
    .derive(() => ({ value: "ok" }))
    .beforeHandle(() => undefined)
    .beforeHandle(() => undefined)
    .get("/budget/:id", (c) => ({ value: c.value, bounded: Number.isFinite(c.budget.remaining()) }))
  const running = app.listen(0, { hostname: "127.0.0.1" })
  try {
    for (const [deadline, status] of [
      [undefined, 200],
      [String(Date.now() + 5_000), 200],
      ["bad", 400],
      [String(Date.now() - 5_000), 408],
    ] satisfies [string | undefined, number][]) {
      const response = await fetch(`http://127.0.0.1:${running.port}/budget/42`, {
        headers: deadline === undefined ? {} : { [NIFRA_DEADLINE_HEADER]: deadline },
      })
      expect(response.status).toBe(status)
      if (status === 200)
        expect(await response.json()).toEqual({ value: "ok", bounded: deadline !== undefined })
      else await response.arrayBuffer()
    }
    expect(finalized).toBe(4)
  } finally {
    running.stop(true)
  }
})
