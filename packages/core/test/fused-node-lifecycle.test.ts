import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import type { NodeResponseBodyHook } from "../src/index.ts"
import { server, silentLogger, status } from "../src/index.ts"
import { nodeDirect } from "../src/node-direct.ts"
import { responseObserver } from "../src/response-observer.ts"
import type { StandardSchemaV1 } from "../src/schema/standard.ts"
import type { NodeServeOutcome } from "../src/server/node-outcome.ts"

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init)
}

const postJson = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

/**
 * The generic fused lifecycle runners (the Node-direct twins of the fused Web
 * derive-before(-after) lanes) must be observably identical to `app.fetch`: same
 * status, same body bytes, same validation/error/early-exit behavior. `app.fetch`
 * rides the long-standing fused Web closures; `resolveNode` rides the new generic
 * runners - any divergence between the two lanes fails here, not in production.
 */
async function expectParity(
  app: ReturnType<typeof server>,
  path: string,
  init?: RequestInit,
): Promise<void> {
  const response = await app.fetch(req(path, init))
  const outcome = (await app.resolveNode(req(path, init))) as NodeServeOutcome
  const webBody = await response.text()
  if (outcome.kind === "json") {
    expect(outcome.status).toBe(response.status)
    expect(outcome.body ?? "").toBe(webBody)
  } else if (outcome.kind === "body") {
    expect(outcome.status).toBe(response.status)
    const text =
      typeof outcome.body === "string" ? outcome.body : new TextDecoder().decode(outcome.body)
    expect(text).toBe(webBody)
  } else {
    expect(outcome.response.status).toBe(response.status)
    expect(await outcome.response.text()).toBe(webBody)
  }
}

const withLifecycle = () =>
  server({ logger: silentLogger })
    .use(nodeDirect())
    .derive((c) => {
      const auth = c.header("authorization")
      if (auth === null || !auth.startsWith("Bearer ") || auth.length < 24) {
        return status(401, { ok: false, error: "unauthorized" })
      }
      return { userId: auth.slice(7, 19), theme: c.cookies.theme ?? "light" }
    })
    .use({
      name: "request-id",
      beforeHandle: (c) => {
        c.set.headers["x-request-id"] = c.header("x-request-id") ?? "generated"
      },
    })

describe("fused generic lifecycle runners - Node-direct parity", () => {
  test("GET query lane: success, validation failure, and auth early-exit", async () => {
    const app = withLifecycle().get(
      "/api/orders",
      { query: t.object({ limit: t.string() }) },
      (c) => ({
        user: c.userId,
        theme: c.theme,
        limit: c.query.limit,
      }),
    )
    const auth = { headers: { authorization: "Bearer abcdefghijklmnopqrstuvwxyz" } }
    await expectParity(app, "/api/orders?limit=10", auth)
    // Missing query param -> 422 on both lanes.
    await expectParity(app, "/api/orders", auth)
    // Bad auth -> derive early-exits 401 on both lanes.
    await expectParity(app, "/api/orders?limit=10")
  })

  test("GET hooks-only lane (no schema): success and thrown control flow", async () => {
    const ok = withLifecycle().get("/ok", (c) => ({ user: c.userId }))
    const boom = withLifecycle().get("/boom", () => {
      throw new Error("handler failed")
    })
    const redirect = withLifecycle().get("/redirect", () => {
      throw Response.redirect("https://example.com/login", 302)
    })
    const auth = { headers: { authorization: "Bearer abcdefghijklmnopqrstuvwxyz" } }
    await expectParity(ok, "/ok", auth)
    await expectParity(boom, "/boom", auth)
    await expectParity(redirect, "/redirect", auth)
  })

  test("GET query + after lane: transform, async stages, after throw", async () => {
    const app = withLifecycle()
      .afterHandle((result) => ({ result }))
      .get("/api/orders", { query: t.object({ limit: t.string() }) }, (c) => ({
        user: c.userId,
        limit: c.query.limit,
      }))
    const auth = { headers: { authorization: "Bearer abcdefghijklmnopqrstuvwxyz" } }
    await expectParity(app, "/api/orders?limit=3", auth)
    await expectParity(app, "/api/orders", auth)

    const asyncApp = server({ logger: silentLogger })
      .use(nodeDirect())
      .derive(async (c) => {
        await Promise.resolve()
        return { userId: c.header("authorization") ?? "anon" }
      })
      .use({
        name: "before",
        beforeHandle: async () => {
          await Promise.resolve()
        },
      })
      .afterHandle(async (result) => {
        await Promise.resolve()
        return { result }
      })
      .get("/async", { query: t.object({ limit: t.string() }) }, (c) => ({
        user: c.userId,
      }))
    await expectParity(asyncApp, "/async?limit=1")

    const afterThrow = server({ logger: silentLogger })
      .use(nodeDirect())
      .derive(() => ({ user: "ada" }))
      .beforeHandle(() => undefined)
      .afterHandle(() => {
        throw new Error("after failed")
      })
      .get("/after-throw", (c) => ({ user: c.user }))
    await expectParity(afterThrow, "/after-throw")
  })

  test("POST body lane: success, validation failure, bad JSON, wrong media type", async () => {
    const app = withLifecycle().post(
      "/api/orders",
      { body: t.object({ sku: t.string(), qty: t.number() }) },
      (c) => ({ ok: true, sku: c.body.sku, qty: c.body.qty, by: c.userId }),
    )
    const auth = { headers: { authorization: "Bearer abcdefghijklmnopqrstuvwxyz" } }
    await expectParity(app, "/api/orders", {
      ...postJson({ sku: "SKU-1", qty: 2 }),
      headers: { ...auth.headers, "content-type": "application/json" },
    })
    // Schema violation -> 422 on both lanes.
    await expectParity(app, "/api/orders", {
      ...postJson({ sku: "SKU-1" }),
      headers: { ...auth.headers, "content-type": "application/json" },
    })
    // Malformed JSON -> 400 on both lanes.
    await expectParity(app, "/api/orders", {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: "{not json",
    })
    // Wrong media type -> 415 on both lanes.
    await expectParity(app, "/api/orders", {
      method: "POST",
      headers: { ...auth.headers, "content-type": "text/plain" },
      body: "hello",
    })
  })

  test("POST body + after lane: transform parity", async () => {
    const app = withLifecycle()
      .afterHandle((result) => ({ result }))
      .post("/api/orders", { body: t.object({ sku: t.string(), qty: t.number() }) }, (c) => ({
        ok: true,
        sku: c.body.sku,
      }))
    const auth = { headers: { authorization: "Bearer abcdefghijklmnopqrstuvwxyz" } }
    await expectParity(app, "/api/orders", {
      ...postJson({ sku: "SKU-1", qty: 2 }),
      headers: { ...auth.headers, "content-type": "application/json" },
    })
  })

  test("beforeHandle early-exit short-circuits identically", async () => {
    const app = server({ logger: silentLogger })
      .use(nodeDirect())
      .derive(() => ({ user: "ada" }))
      .use({
        name: "gate",
        beforeHandle: (c) => {
          if (c.header("x-block") !== null) return status(403, { ok: false })
          return undefined
        },
      })
      .get("/gated", { query: t.object({ limit: t.string() }) }, (c) => ({
        user: c.user,
      }))
    await expectParity(app, "/gated?limit=1")
    await expectParity(app, "/gated?limit=1", { headers: { "x-block": "1" } })
  })

  test("early exits that fail during Node finalization enter the 500 error lane", async () => {
    const assertInternalError = async (app: ReturnType<typeof server>) => {
      const outcome = await app.resolveNode(req("/early"))
      expect(outcome.kind).toBe("json")
      if (outcome.kind !== "json") return
      expect(outcome.status).toBe(500)
      expect(outcome.body).toBe('{"ok":false,"error":"internal_error"}')
    }

    const derive = server({ logger: silentLogger })
      .use(nodeDirect())
      .derive(() => status(200, 1n))
      .beforeHandle(() => undefined)
      .get("/early", () => ({ ok: true }))
    await assertInternalError(derive)

    const before = server({ logger: silentLogger })
      .use(nodeDirect())
      .derive(() => ({ ok: true }))
      .beforeHandle(() => status(200, 1n))
      .get("/early", () => ({ ok: true }))
    await assertInternalError(before)

    const asyncBefore = server({ logger: silentLogger })
      .use(nodeDirect())
      .derive(() => ({ ok: true }))
      .beforeHandle(async () => status(200, 1n))
      .get("/early", () => ({ ok: true }))
    await assertInternalError(asyncBefore)
  })

  test("body lifecycle runner covers async stages and async validation", async () => {
    const asyncApp = server({ logger: silentLogger })
      .use(nodeDirect())
      .derive(async () => ({ user: "ada" }))
      .beforeHandle(async () => undefined)
      .afterHandle(async (result) => ({ result, after: await Promise.resolve(true) }))
      .post("/async-body", { body: t.object({ name: t.string() }) }, (c) => ({
        user: c.user,
        name: c.body.name,
      }))
    const asyncOutcome = (await asyncApp.resolveNode(
      req("/async-body", postJson({ name: "Ada" })),
    )) as NodeServeOutcome
    expect(asyncOutcome.kind).toBe("json")
    if (asyncOutcome.kind === "json") {
      expect(asyncOutcome.status).toBe(200)
      expect(asyncOutcome.body).toContain('"after":true')
    }

    const asyncBody: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async (value) => ({ value }),
      },
    }
    const validationApp = server({ logger: silentLogger })
      .use(nodeDirect())
      .derive(() => ({ user: "ada" }))
      .beforeHandle(() => undefined)
      .post("/async-validate", { body: asyncBody }, (c) => ({ user: c.user, body: c.body }))
    const validationOutcome = (await validationApp.resolveNode(
      req("/async-validate", postJson({ name: "Ada" })),
    )) as NodeServeOutcome
    expect(validationOutcome.kind).toBe("json")
    if (validationOutcome.kind === "json") expect(validationOutcome.status).toBe(200)

    const earlyApp = server({ logger: silentLogger })
      .use(nodeDirect())
      .derive(async () => status(401, { ok: false }))
      .beforeHandle(async () => undefined)
      .post("/async-early", { body: t.object({ name: t.string() }) }, () => ({ ok: true }))
    const earlyOutcome = (await earlyApp.resolveNode(
      req("/async-early", postJson({ name: "Ada" })),
    )) as NodeServeOutcome
    expect(earlyOutcome.kind).toBe("json")
    if (earlyOutcome.kind === "json") expect(earlyOutcome.status).toBe(401)
  })
})

describe("body-tier node twin", () => {
  const hash = (s: string): string => {
    let h = 5381
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
    return (h >>> 0).toString(16)
  }
  const textOf = (body: string | Uint8Array): string =>
    typeof body === "string" ? body : new TextDecoder().decode(body)

  /** The portable hook and its twin, sharing call flags so each lane's choice is observable. */
  const hashedPair = (calls: { portable: number; twin: number }) => ({
    portable: (body: string | Uint8Array, headers: { set(name: string, value: string): void }) => {
      calls.portable += 1
      headers.set("x-body-hash", hash(textOf(body)))
      return undefined
    },
    twin: ((body, res) => {
      calls.twin += 1
      res.headers ??= {}
      res.headers["x-body-hash"] = hash(textOf(body))
      return undefined
    }) as NodeResponseBodyHook,
  })

  const twinApp = (calls: { portable: number; twin: number }) =>
    server({ logger: silentLogger })
      .use(nodeDirect())
      .use(responseObserver())
      .onResponseBody(hashedPair(calls).portable, hashedPair(calls).twin)
      .get("/data", () => ({ ok: true, id: "ord_1" }))

  test("twin serves the Node lane, portable serves the Web lane, same bytes", async () => {
    const viaNode = { portable: 0, twin: 0 }
    const viaWeb = { portable: 0, twin: 0 }
    const forNode = twinApp(viaNode)
    const forWeb = twinApp(viaWeb)

    const outcome = (await forNode.resolveNode(req("/data"))) as NodeServeOutcome
    expect(viaNode).toEqual({ portable: 0, twin: 1 })
    expect(outcome.kind).toBe("json")
    if (outcome.kind !== "json") throw new Error("unreachable")
    const expected = JSON.stringify({ ok: true, id: "ord_1" })
    expect(outcome.body).toBe(expected)
    expect(outcome.headers?.["x-body-hash"]).toBe(hash(expected))

    const response = await forWeb.fetch(req("/data"))
    expect(viaWeb).toEqual({ portable: 1, twin: 0 })
    expect(await response.text()).toBe(expected)
    expect(response.headers.get("x-body-hash")).toBe(hash(expected))
  })

  test("string replacement matches the portable hook on each lane", async () => {
    const twinCalls: string[] = []
    const portableCalls: string[] = []
    const twin: NodeResponseBodyHook = (body) => {
      twinCalls.push(textOf(body))
      return "replaced"
    }
    const withTwin = server({ logger: silentLogger })
      .use(nodeDirect())
      .use(responseObserver())
      .onResponseBody((body) => {
        portableCalls.push(textOf(body))
        return "replaced"
      }, twin)
      .get("/data", () => ({ ok: true }))
    const portableOnly = server({ logger: silentLogger })
      .use(nodeDirect())
      .use(responseObserver())
      .onResponseBody((body) => {
        portableCalls.push(textOf(body))
        return "replaced"
      })
      .get("/data", () => ({ ok: true }))

    const twinOutcome = (await withTwin.resolveNode(req("/data"))) as NodeServeOutcome
    const portableOutcome = (await portableOnly.resolveNode(req("/data"))) as NodeServeOutcome
    expect(twinOutcome).toEqual(portableOutcome)
    expect(twinCalls).toEqual(portableCalls)
    expect(twinCalls).toEqual([JSON.stringify({ ok: true })])

    // The Web lane renders the same replacement text through the Response path.
    expect(await (await withTwin.fetch(req("/data"))).text()).toBe("replaced")
    expect(await (await portableOnly.fetch(req("/data"))).text()).toBe("replaced")
  })

  test("replacement object and binary replacement match the portable hook", async () => {
    const build = (
      replace: (
        body: string | Uint8Array,
      ) => string | Uint8Array | { body: string | Uint8Array | null; status?: number } | undefined,
      twinReplace: (
        body: string | Uint8Array,
      ) => string | Uint8Array | { body: string | Uint8Array | null; status?: number } | undefined,
    ) => {
      const withTwin = server({ logger: silentLogger })
        .use(nodeDirect())
        .use(responseObserver())
        .onResponseBody(replace as never, twinReplace as NodeResponseBodyHook)
        .get("/data", () => ({ ok: true }))
      const portableOnly = server({ logger: silentLogger })
        .use(nodeDirect())
        .use(responseObserver())
        .onResponseBody(replace as never)
        .get("/data", () => ({ ok: true }))
      return { withTwin, portableOnly }
    }

    const statusCase = build(
      () => ({ body: "created", status: 201 }),
      () => ({ body: "created", status: 201 }),
    )
    const twinStatus = (await statusCase.withTwin.resolveNode(req("/data"))) as NodeServeOutcome
    const portableStatus = (await statusCase.portableOnly.resolveNode(
      req("/data"),
    )) as NodeServeOutcome
    expect(twinStatus).toEqual(portableStatus)
    expect(twinStatus.kind).toBe("json")
    if (twinStatus.kind === "json") {
      expect(twinStatus.status).toBe(201)
      expect(twinStatus.body).toBe("created")
    }
    expect((await statusCase.withTwin.fetch(req("/data"))).status).toBe(201)

    const binaryCase = build(
      () => new Uint8Array([104, 105]),
      () => new Uint8Array([104, 105]),
    )
    const twinBinary = (await binaryCase.withTwin.resolveNode(req("/data"))) as NodeServeOutcome
    const portableBinary = (await binaryCase.portableOnly.resolveNode(
      req("/data"),
    )) as NodeServeOutcome
    expect(twinBinary).toEqual(portableBinary)
    expect(twinBinary.kind).toBe("body")
    expect(await binaryCase.withTwin.fetch(req("/data"))).toBeTruthy()
    expect(await (await binaryCase.withTwin.fetch(req("/data"))).text()).toBe("hi")
  })

  test("null body skips the twin exactly like the portable hook", async () => {
    let twinCalls = 0
    let portableCalls = 0
    const app = server({ logger: silentLogger })
      .use(nodeDirect())
      .use(responseObserver())
      .onResponseBody(
        () => {
          portableCalls += 1
          return undefined
        },
        () => {
          twinCalls += 1
          return undefined
        },
      )
      .get("/empty", () => undefined)

    const outcome = (await app.resolveNode(req("/empty"))) as NodeServeOutcome
    expect(outcome.kind).toBe("json")
    if (outcome.kind === "json") expect(outcome.status).toBe(204)
    expect(twinCalls).toBe(0)
    const response = await app.fetch(req("/empty"))
    expect(response.status).toBe(204)
    expect(portableCalls).toBe(0)
  })

  test("async twin and twin throw match the portable hook", async () => {
    const asyncApp = server({ logger: silentLogger })
      .use(nodeDirect())
      .use(responseObserver())
      .onResponseBody(
        async (_body, headers) => {
          await Promise.resolve()
          headers.set("x-async", "portable")
          return undefined
        },
        (async (_body, res) => {
          await Promise.resolve()
          res.headers ??= {}
          res.headers["x-async"] = "twin"
          return undefined
        }) as NodeResponseBodyHook,
      )
      .get("/data", () => ({ ok: true }))
    const outcome = (await asyncApp.resolveNode(req("/data"))) as NodeServeOutcome
    expect(outcome.kind).toBe("json")
    if (outcome.kind === "json") expect(outcome.headers?.["x-async"]).toBe("twin")
    expect((await asyncApp.fetch(req("/data"))).headers.get("x-async")).toBe("portable")

    const throwingTwin = () => {
      throw new Error("twin failed")
    }
    // A throwing hook rejects resolveNode identically on both implementations (the adapter
    // turns that rejection into its flat 500); each lane runs its own hook, so the fetch
    // status follows whichever hook the lane runs.
    const twinThrowApp = server({ logger: silentLogger })
      .use(nodeDirect())
      .use(responseObserver())
      .onResponseBody(() => undefined, throwingTwin as NodeResponseBodyHook)
      .get("/data", () => ({ ok: true }))
    const portableThrowApp = server({ logger: silentLogger })
      .use(nodeDirect())
      .use(responseObserver())
      .onResponseBody(() => {
        throw new Error("portable failed")
      })
      .get("/data", () => ({ ok: true }))
    await expect(twinThrowApp.resolveNode(req("/data"))).rejects.toThrow()
    await expect(portableThrowApp.resolveNode(req("/data"))).rejects.toThrow()
    // Each lane runs its own hook: the twin lane's fetch stays 200 (its portable hook is
    // benign), while a throwing hook rejects the Web lane too - response-hook failures are
    // fail-open rejections by design (see failResponseFinalization), on both lanes alike.
    expect((await twinThrowApp.fetch(req("/data"))).status).toBe(200)
    await expect(portableThrowApp.fetch(req("/data"))).rejects.toThrow("portable failed")
  })

  test("a __proto__ write through the twin is inert, never pollution", async () => {
    const app = server({ logger: silentLogger })
      .use(nodeDirect())
      .use(responseObserver())
      .onResponseBody(() => undefined, ((_body, res) => {
        res.headers ??= {}
        // biome-ignore lint/complexity/useLiteralKeys: the literal key IS the attack
        res.headers["__proto__"] = "polluted"
        res.headers["x-ok"] = "1"
        return undefined
      }) as NodeResponseBodyHook)
      .get("/data", () => ({ ok: true }))
    const outcome = (await app.resolveNode(req("/data"))) as NodeServeOutcome
    expect(outcome.kind).toBe("json")
    if (outcome.kind === "json") expect(outcome.headers?.["x-ok"]).toBe("1")
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty("polluted")
  })

  test("middleware-declared twin is used on Node; unpaired twin throws", async () => {
    const calls = { portable: 0, twin: 0 }
    const pair = hashedPair(calls)
    const app = server({ logger: silentLogger })
      .use(nodeDirect())
      .use(responseObserver())
      .use({
        name: "hash",
        onResponseBody: pair.portable as never,
        onNodeResponseBody: pair.twin,
      })
      .get("/data", () => ({ ok: true, id: "ord_1" }))
    const outcome = (await app.resolveNode(req("/data"))) as NodeServeOutcome
    expect(calls).toEqual({ portable: 0, twin: 1 })
    expect(outcome.kind).toBe("json")
    if (outcome.kind === "json") {
      expect(outcome.headers?.["x-body-hash"]).toBe(hash(JSON.stringify({ ok: true, id: "ord_1" })))
    }
    const response = await app.fetch(req("/data"))
    expect(calls).toEqual({ portable: 1, twin: 1 })
    expect(response.headers.get("x-body-hash")).toBe(
      hash(JSON.stringify({ ok: true, id: "ord_1" })),
    )

    expect(() =>
      server()
        .use(nodeDirect())
        .use(responseObserver())
        .use({ name: "lonely", onNodeResponseBody: pair.twin }),
    ).toThrow(TypeError)
  })
})
