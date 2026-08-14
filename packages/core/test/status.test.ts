import { describe, expect, test } from "bun:test"
import { server, silentLogger, status } from "../src/index.ts"
import { nodeDirect } from "../src/node-direct.ts"
import type { StandardResult, StandardSchemaV1, StandardTypes } from "../src/schema/standard.ts"

/**
 * `status(...)` - finish the request now, with this status and body, without building a `Response`.
 *
 * Two things are pinned here. The BEHAVIOUR: it works returned or thrown, from a handler or from any
 * lifecycle stage, and it is control flow rather than an error or a contract payload. And the SHAPE
 * it renders as, which is the whole point of it existing: on the node-direct lane it must produce the
 * same `kind: "json"` outcome a handler's plain return produces - no `Response` built, so the adapter
 * writes it with a `content-length` instead of falling to chunked - and it must carry the request's
 * `c.set.headers` and queued cookies, which a raw `Response` silently drops.
 */

const UNAUTHORIZED = { ok: false, error: "unauthorized" } as const

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init)
}

function schema<Output>(
  validate: (value: unknown) => StandardResult<Output>,
): StandardSchemaV1<unknown, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "nifra-test",
      validate,
      types: undefined as unknown as StandardTypes<unknown, Output>,
    },
  }
}

describe("status() - returned", () => {
  test("from a handler: status, JSON body, json content-type", async () => {
    const app = server().get("/x", () => status(401, UNAUTHORIZED))
    const response = await app.fetch(req("/x"))
    expect(response.status).toBe(401)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(await response.json()).toEqual(UNAUTHORIZED)
  })

  test("from a derive: ends the request, handler never runs", async () => {
    let handlerRan = false
    const app = server()
      .derive(() => status(401, UNAUTHORIZED))
      .get("/x", () => {
        handlerRan = true
        return { ok: true }
      })
    const response = await app.fetch(req("/x"))
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual(UNAUTHORIZED)
    expect(handlerRan).toBe(false)
  })

  test("from an async derive, and from a later derive in the chain", async () => {
    let handlerRan = false
    const app = server()
      .derive(async () => ({ tenant: "acme" }))
      .derive((c) => (c.tenant === "acme" ? status(403, { ok: false }) : { role: "admin" }))
      .get("/x", () => {
        handlerRan = true
        return { ok: true }
      })
    const response = await app.fetch(req("/x"))
    expect(response.status).toBe(403)
    expect(handlerRan).toBe(false)
  })

  test("a derive returning a Response ends the request too (it never extended the context)", async () => {
    let handlerRan = false
    const app = server()
      .derive(() => new Response(null, { status: 303, headers: { location: "/login" } }))
      .get("/x", () => {
        handlerRan = true
        return { ok: true }
      })
    const response = await app.fetch(req("/x"))
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("/login")
    expect(handlerRan).toBe(false)
  })

  test("from a beforeHandle", async () => {
    const app = server()
      .use({ name: "guard", beforeHandle: () => status(401, UNAUTHORIZED) })
      .get("/x", () => ({ ok: true }))
    const response = await app.fetch(req("/x"))
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual(UNAUTHORIZED)
  })

  test("no body: an empty response with the given status", async () => {
    const app = server().get("/x", () => status(403))
    const response = await app.fetch(req("/x"))
    expect(response.status).toBe(403)
    expect(await response.text()).toBe("")
  })

  test("its own headers ship, and win over c.set.headers", async () => {
    const app = server()
      .use({
        name: "request-id",
        beforeHandle: (c) => {
          c.set.headers["x-request-id"] = "abc"
          c.set.headers["x-source"] = "ambient"
        },
      })
      .get("/x", () => status(401, UNAUTHORIZED, { headers: { "x-source": "exit" } }))
    const response = await app.fetch(req("/x"))
    expect(response.headers.get("x-request-id")).toBe("abc")
    expect(response.headers.get("x-source")).toBe("exit")
  })

  test("queued cookies still apply", async () => {
    const app = server().get("/x", (c) => {
      c.set.cookie("session", "", { maxAge: 0, path: "/" })
      return status(401, UNAUTHORIZED)
    })
    const response = await app.fetch(req("/x"))
    expect(response.status).toBe(401)
    expect(response.headers.get("set-cookie")).toContain("session=")
  })

  test("a hoisted value answers many requests unchanged", async () => {
    const denied = status(429, { ok: false }, { headers: { "retry-after": "1" } })
    const app = server().get("/x", () => denied)
    for (let i = 0; i < 3; i++) {
      const response = await app.fetch(req("/x"))
      expect(response.status).toBe(429)
      expect(response.headers.get("retry-after")).toBe("1")
      expect(await response.json()).toEqual({ ok: false })
    }
  })
})

describe("status() - thrown", () => {
  test("from a handler: control flow, not a 500", async () => {
    const app = server({ logger: silentLogger }).get("/x", () => {
      throw status(401, UNAUTHORIZED)
    })
    const response = await app.fetch(req("/x"))
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual(UNAUTHORIZED)
  })

  test("from a derive - the shape a guard helper called for effect leaves behind", async () => {
    const app = server({ logger: silentLogger })
      .derive(() => {
        throw status(401, UNAUTHORIZED)
      })
      .get("/x", () => ({ ok: true }))
    const response = await app.fetch(req("/x"))
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual(UNAUTHORIZED)
  })

  test("onError never sees it, and nothing is logged as an error", async () => {
    let onErrorRan = false
    let logged = 0
    const app = server({
      logger: { ...silentLogger, error: () => void logged++ },
    })
      .use({
        name: "catcher",
        onError: () => {
          onErrorRan = true
          return undefined
        },
      })
      .get("/x", () => {
        throw status(401, UNAUTHORIZED)
      })
    const response = await app.fetch(req("/x"))
    expect(response.status).toBe(401)
    expect(onErrorRan).toBe(false)
    expect(logged).toBe(0)
  })

  test("a thrown Error still 500s", async () => {
    const app = server({ logger: silentLogger }).get("/x", () => {
      throw new Error("boom")
    })
    const response = await app.fetch(req("/x"))
    expect(response.status).toBe(500)
  })
})

describe("status() - response contract", () => {
  const okSchema = schema<{ ok: true }>((value) =>
    typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === true
      ? { value: { ok: true } }
      : { issues: [{ message: "expected ok: true" }] },
  )

  test("an early exit is control flow, not the declared payload", async () => {
    const app = server({ logger: silentLogger })
      .derive(() => status(401, UNAUTHORIZED))
      .get("/x", { response: okSchema }, () => ({ ok: true }) as const)
    const response = await app.fetch(req("/x"))
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual(UNAUTHORIZED)
  })
})

describe("status() - node-direct lane", () => {
  test("renders as kind:json - the plain lane, no Response built", async () => {
    const app = server()
      .use(nodeDirect())
      .get("/x", () => status(401, UNAUTHORIZED))
    const outcome = await app.resolveNode(req("/x"))
    expect(outcome.kind).toBe("json")
    if (outcome.kind !== "json") throw new Error("unreachable")
    expect(outcome.status).toBe(401)
    expect(outcome.body).toBe(JSON.stringify(UNAUTHORIZED))
  })

  test("the same for a derive's early exit, thrown or returned", async () => {
    for (const app of [
      server({ logger: silentLogger })
        .use(nodeDirect())
        .derive(() => status(401, UNAUTHORIZED))
        .get("/x", () => ({ ok: true })),
      server({ logger: silentLogger })
        .use(nodeDirect())
        .derive(() => {
          throw status(401, UNAUTHORIZED)
        })
        .get("/x", () => ({ ok: true })),
    ]) {
      const outcome = await app.resolveNode(req("/x"))
      expect(outcome.kind).toBe("json")
      if (outcome.kind !== "json") throw new Error("unreachable")
      expect(outcome.status).toBe(401)
      expect(outcome.body).toBe(JSON.stringify(UNAUTHORIZED))
    }
  })

  test("carries c.set.headers and cookies - which a raw Response drops", async () => {
    const app = server()
      .use(nodeDirect())
      .use({
        name: "request-id",
        beforeHandle: (c) => {
          c.set.headers["x-request-id"] = "abc"
        },
      })
      .get("/x", (c) => {
        c.set.cookie("session", "", { maxAge: 0, path: "/" })
        return status(401, UNAUTHORIZED)
      })
    const outcome = await app.resolveNode(req("/x"))
    expect(outcome.kind).toBe("json")
    if (outcome.kind !== "json") throw new Error("unreachable")
    expect(outcome.headers?.["x-request-id"]).toBe("abc")
    expect(outcome.cookies?.[0]).toContain("session=")
  })

  test("byte-identical to the same answer given via c.set.status", async () => {
    const viaStatus = server()
      .use(nodeDirect())
      .get("/x", () => status(401, UNAUTHORIZED))
    const viaSet = server()
      .use(nodeDirect())
      .get("/x", (c) => {
        c.set.status = 401
        return UNAUTHORIZED
      })
    const a = await viaStatus.resolveNode(req("/x"))
    const b = await viaSet.resolveNode(req("/x"))
    expect(a).toEqual(b)
  })

  test("a bodyless status renders as a null body", async () => {
    const app = server()
      .use(nodeDirect())
      .get("/x", () => status(204))
    const outcome = await app.resolveNode(req("/x"))
    expect(outcome.kind).toBe("json")
    if (outcome.kind !== "json") throw new Error("unreachable")
    expect(outcome.status).toBe(204)
    expect(outcome.body).toBeNull()
  })
})
