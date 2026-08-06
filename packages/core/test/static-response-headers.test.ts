import { describe, expect, test } from "bun:test"
import { server, silentLogger } from "../src/index.ts"
import { nodeDirect } from "../src/node-direct.ts"
import type { StandardResult, StandardSchemaV1, StandardTypes } from "../src/schema/standard.ts"
import type { ResponseHeadersView } from "../src/server/server.ts"

/**
 * `app.responseHeaders()` declares response headers that are NOT a response hook: they fold into
 * response construction, so an app whose response middleware is only static keeps the fused/native
 * lanes a hook would cost it.
 *
 * These tests pin the two things that make that safe: (a) the wire is identical to registering the
 * same headers as the equivalent `onResponseHeaders` hook, on every render path and on both the Web
 * and Node-direct lanes, and (b) the lane gates the feature exists for stay open.
 */

const DECLARED = {
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const

/** The hook form of the same declaration: defaults, applied in the response walk. */
function declaredAsHook(headers: ResponseHeadersView): void {
  for (const [name, value] of Object.entries(DECLARED)) {
    if (!headers.has(name)) headers.set(name, value)
  }
}

/** The gate every fused/native lane reads. Declaring static headers must leave it at zero - that is
 * the entire point of the tier, so assert the gate input directly rather than a proxy for it. */
function responseHookCount(app: unknown): number {
  return (app as { onResponseHooks: readonly unknown[] }).onResponseHooks.length
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

const nameOnly = schema<{ name: string }>((value) =>
  typeof value === "object" && value !== null && "name" in value && typeof value.name === "string"
    ? { value: { name: value.name } }
    : { issues: [{ message: "name must be a string", path: ["name"] }] },
)

/** Every render path a response hook would cover, on one app shape. */
function withRoutes<A>(app: A): A {
  const typed = app as {
    get: (path: string, a: unknown, b?: unknown) => unknown
    post: (path: string, a: unknown, b?: unknown) => unknown
  }
  typed.get("/json", () => ({ ok: true }))
  typed.get("/own-headers", (c: { set: { headers: Record<string, string> } }) => {
    c.set.headers["x-own"] = "1"
    return { ok: true }
  })
  typed.get("/own-collision", (c: { set: { headers: Record<string, string> } }) => {
    c.set.headers["X-Frame-Options"] = "SAMEORIGIN"
    return { ok: true }
  })
  typed.get("/created", (c: { set: { status: number; headers: Record<string, string> } }) => {
    c.set.status = 201
    c.set.headers["x-own"] = "1"
    return { id: 1 }
  })
  typed.get("/empty", () => undefined)
  typed.get("/raw", () => new Response("raw", { headers: { "x-raw": "1" } }))
  typed.get("/not-modified", () => new Response(null, { status: 304 }))
  typed.get("/cookie", (c: { set: { cookie: (n: string, v: string) => void } }) => {
    c.set.cookie("sid", "abc")
    return { ok: true }
  })
  typed.get("/redirect", () => new Response(null, { status: 302, headers: { location: "/next" } }))
  typed.get("/boom", () => {
    throw new Error("x")
  })
  typed.get("/thrown-response", () => {
    throw new Response("nope", { status: 418 })
  })
  typed.get("/search", { query: nameOnly }, (c: { query: { name: string } }) => ({
    name: c.query.name,
  }))
  typed.post("/users", { body: nameOnly }, (c: { body: { name: string } }) => ({
    created: c.body.name,
  }))
  return app
}

function staticApp() {
  return withRoutes(
    server({ logger: silentLogger }).use(nodeDirect()).responseHeaders(DECLARED),
  ) as ReturnType<typeof server>
}

function hookApp() {
  return withRoutes(
    server({ logger: silentLogger }).use(nodeDirect()).onResponseHeaders(declaredAsHook),
  ) as ReturnType<typeof server>
}

/** Requests covering every path above, plus the ones no route serves. */
const CASES: ReadonlyArray<{ readonly name: string; readonly request: () => Request }> = [
  { name: "bare json", request: () => new Request("http://x/json") },
  { name: "own headers", request: () => new Request("http://x/own-headers") },
  { name: "mixed-case collision", request: () => new Request("http://x/own-collision") },
  { name: "created", request: () => new Request("http://x/created") },
  { name: "204", request: () => new Request("http://x/empty") },
  { name: "raw response", request: () => new Request("http://x/raw") },
  { name: "304", request: () => new Request("http://x/not-modified") },
  { name: "cookie", request: () => new Request("http://x/cookie") },
  { name: "redirect", request: () => new Request("http://x/redirect") },
  { name: "500", request: () => new Request("http://x/boom") },
  { name: "thrown response", request: () => new Request("http://x/thrown-response") },
  { name: "query valid", request: () => new Request("http://x/search?name=ada") },
  { name: "query invalid", request: () => new Request("http://x/search") },
  {
    name: "body valid",
    request: () =>
      new Request("http://x/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "ada" }),
      }),
  },
  {
    name: "body invalid",
    request: () =>
      new Request("http://x/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: 1 }),
      }),
  },
  { name: "404", request: () => new Request("http://x/missing") },
  {
    name: "405",
    request: () => new Request("http://x/json", { method: "DELETE" }),
  },
]

/** A comparable dump of what a response puts on the wire. */
async function dumpResponse(response: Response): Promise<unknown> {
  const headers = [...response.headers].map(([name, value]) => [name.toLowerCase(), value])
  headers.sort()
  return {
    status: response.status,
    headers,
    setCookie: response.headers.getSetCookie?.() ?? [],
    body: await response.text(),
  }
}

/** Parity alone would pass if BOTH lanes dropped the headers - so pin that they landed. */
function expectDeclared(dump: unknown, override?: readonly [string, string]): void {
  const { headers } = dump as { headers: string[][] }
  for (const [name, value] of Object.entries(DECLARED)) {
    if (override !== undefined && override[0] === name) continue
    expect(headers).toContainEqual([name, value])
  }
  if (override !== undefined) expect(headers).toContainEqual([override[0], override[1]])
}

describe("responseHeaders() - wire parity with the equivalent hook", () => {
  for (const { name, request } of CASES) {
    test(`app.fetch: ${name}`, async () => {
      const viaStatic = await dumpResponse(await staticApp().fetch(request()))
      const viaHook = await dumpResponse(await hookApp().fetch(request()))
      expect(viaStatic).toEqual(viaHook)
      expectDeclared(
        viaStatic,
        name === "mixed-case collision" ? ["x-frame-options", "SAMEORIGIN"] : undefined,
      )
    })
  }

  test("app.fetch: timeout render", async () => {
    const slow = (app: ReturnType<typeof server>) =>
      (app as unknown as { get: (p: string, h: () => Promise<never>) => void }).get(
        "/slow",
        () => new Promise<never>(() => {}),
      )
    const withStatic = server({ requestTimeoutMs: 5, logger: silentLogger }).responseHeaders(
      DECLARED,
    )
    slow(withStatic as unknown as ReturnType<typeof server>)
    const withHook = server({ requestTimeoutMs: 5, logger: silentLogger }).onResponseHeaders(
      declaredAsHook,
    )
    slow(withHook as unknown as ReturnType<typeof server>)

    const viaStatic = await dumpResponse(await withStatic.fetch(new Request("http://x/slow")))
    const viaHook = await dumpResponse(await withHook.fetch(new Request("http://x/slow")))
    expect(viaStatic).toEqual(viaHook)
    expect((viaStatic as { status: number }).status).toBe(503)
    expect((viaStatic as { headers: string[][] }).headers).toContainEqual([
      "x-frame-options",
      "DENY",
    ])
  })

  test("app.fetch: onRequest short-circuit", async () => {
    const blocked = (app: ReturnType<typeof server>) =>
      (app as unknown as { onRequest: (fn: () => Response) => void }).onRequest(
        () => new Response("blocked", { status: 403 }),
      )
    const withStatic = server({ logger: silentLogger }).responseHeaders(DECLARED)
    blocked(withStatic as unknown as ReturnType<typeof server>)
    const withHook = server({ logger: silentLogger }).onResponseHeaders(declaredAsHook)
    blocked(withHook as unknown as ReturnType<typeof server>)

    expect(await dumpResponse(await withStatic.fetch(new Request("http://x/any")))).toEqual(
      await dumpResponse(await withHook.fetch(new Request("http://x/any"))),
    )
  })
})

describe("responseHeaders() - Node-direct parity", () => {
  for (const { name, request } of CASES) {
    test(`resolveNode: ${name}`, async () => {
      const viaStatic = await dumpNodeOutcome(await staticApp().resolveNode(request()))
      const viaHook = await dumpNodeOutcome(await hookApp().resolveNode(request()))
      expect(viaStatic).toEqual(viaHook)
      expectDeclared(
        viaStatic,
        name === "mixed-case collision" ? ["x-frame-options", "SAMEORIGIN"] : undefined,
      )
    })
  }
})

/**
 * Normalize a Node outcome to the bytes its writer would emit. The two lanes reach the same wire by
 * different routes: the hook lane materializes the implicit JSON content-type into the record so a
 * body hook can read it, while the static lane leaves the writer to add it - so comparing records
 * verbatim would report a difference the socket never sees.
 */
async function dumpNodeOutcome(
  outcome: Awaited<ReturnType<ReturnType<typeof staticApp>["resolveNode"]>>,
): Promise<unknown> {
  if (outcome.kind === "response") {
    return { via: "response", ...((await dumpResponse(outcome.response)) as object) }
  }
  const headers: string[][] = []
  const seen = new Set<string>()
  for (const [name, value] of Object.entries(outcome.headers ?? {})) {
    const lower = name.toLowerCase()
    seen.add(lower)
    for (const item of typeof value === "string" ? [value] : value) headers.push([lower, item])
  }
  const body = outcome.body
  if (outcome.kind === "json") {
    if (body !== null && !seen.has("content-type")) {
      headers.push(["content-type", "application/json;charset=utf-8"])
    }
    for (const cookie of outcome.cookies ?? []) headers.push(["set-cookie", cookie])
  }
  headers.sort()
  return {
    via: "direct",
    status: outcome.status,
    headers,
    body: typeof body === "string" ? body : body === null ? "" : new TextDecoder().decode(body),
  }
}

describe("responseHeaders() - lane retention", () => {
  test("declaring headers registers no response hook", () => {
    const app = server()
      .responseHeaders(DECLARED)
      .get("/", () => ({ ok: true }))
    expect(responseHookCount(app)).toBe(0)
  })

  test("the Node direct JSON writer is retained", async () => {
    const app = server()
      .use(nodeDirect())
      .responseHeaders(DECLARED)
      .get("/", () => ({ ok: true }))
    const outcome = await app.resolveNode(new Request("http://x/"))
    expect(outcome.kind).toBe("json")
    if (outcome.kind !== "json") throw new Error("unreachable")
    expect(outcome.headers?.["x-frame-options"]).toBe("DENY")
    // The writer's all-lowercase fast path must still apply: declared names are lowercased once.
    expect(Object.keys(outcome.headers ?? {}).every((key) => key === key.toLowerCase())).toBe(true)
  })

  test("headers ship over a real Bun listen(), where fused native routes serve", async () => {
    const app = server()
      .responseHeaders(DECLARED)
      .get("/json", () => ({ ok: true }))
    const running = app.listen(0)
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/json`)
      expect(res.headers.get("x-frame-options")).toBe("DENY")
      expect(res.headers.get("referrer-policy")).toBe("no-referrer")
      expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8")
      expect(await res.json()).toEqual({ ok: true })
    } finally {
      await app.stop()
    }
  })
})

describe("responseHeaders() - semantics", () => {
  test("declared values are defaults: a value the request set wins", async () => {
    const app = server()
      .responseHeaders(DECLARED)
      .get("/", (c) => {
        c.set.headers["x-frame-options"] = "SAMEORIGIN"
        return { ok: true }
      })
    const res = await app.fetch(new Request("http://x/"))
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN")
    expect(res.headers.get("referrer-policy")).toBe("no-referrer")
  })

  test("a mixed-case collision yields ONE header, not a joined pair", async () => {
    const app = server()
      .use(nodeDirect())
      .responseHeaders(DECLARED)
      .get("/", (c) => {
        c.set.headers["X-Frame-Options"] = "SAMEORIGIN"
        return { ok: true }
      })
    const res = await app.fetch(new Request("http://x/"))
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN")

    const outcome = await app.resolveNode(new Request("http://x/"))
    if (outcome.kind !== "json") throw new Error("expected the direct lane")
    const names = Object.keys(outcome.headers ?? {}).filter(
      (name) => name.toLowerCase() === "x-frame-options",
    )
    expect(names).toEqual(["X-Frame-Options"])
    expect(outcome.headers?.["X-Frame-Options"]).toBe("SAMEORIGIN")
  })

  test("a later response hook overrides a declared value", async () => {
    const app = server()
      .responseHeaders(DECLARED)
      .onResponseHeaders((headers) => headers.set("x-frame-options", "SAMEORIGIN"))
      .get("/", () => ({ ok: true }))
    const res = await app.fetch(new Request("http://x/"))
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN")
  })

  test("response hooks see declared values through their view on both lanes", async () => {
    const seen: string[] = []
    const app = server()
      .use(nodeDirect())
      .responseHeaders(DECLARED)
      .onResponseHeaders((headers) => {
        seen.push(headers.get("x-frame-options") ?? "missing")
      })
      .get("/", () => ({ ok: true }))
    await app.fetch(new Request("http://x/"))
    await app.resolveNode(new Request("http://x/"))
    expect(seen).toEqual(["DENY", "DENY"])
  })

  test("a body hook sees declared values and keeps the direct lane", async () => {
    const seen: (string | null)[] = []
    const app = server()
      .use(nodeDirect())
      .responseHeaders(DECLARED)
      .onResponseBody((body, headers) => {
        seen.push(headers.get("referrer-policy"))
        return body
      })
      .get("/", () => ({ ok: true }))
    const outcome = await app.resolveNode(new Request("http://x/"))
    expect(outcome.kind).toBe("json")
    expect(seen).toEqual(["no-referrer"])
  })

  test("declarations merge in order; the last one wins a repeated name", async () => {
    const app = server()
      .responseHeaders({ "x-a": "1", "x-b": "1" })
      .responseHeaders({ "x-b": "2", "x-c": "3" })
      .get("/", () => ({ ok: true }))
    const res = await app.fetch(new Request("http://x/"))
    expect(res.headers.get("x-a")).toBe("1")
    expect(res.headers.get("x-b")).toBe("2")
    expect(res.headers.get("x-c")).toBe("3")
  })

  test("names are lowercased once, so any casing is accepted", async () => {
    const app = server()
      .responseHeaders({ "X-Frame-Options": "DENY" })
      .get("/", () => ({ ok: true }))
    const res = await app.fetch(new Request("http://x/"))
    expect(res.headers.get("x-frame-options")).toBe("DENY")
  })

  test("a declaration made AFTER a response hook keeps registration order", async () => {
    const app = server()
      .onResponseHeaders((headers) => headers.set("x-order", "hook"))
      .responseHeaders({ "x-order": "static" })
      .get("/", () => ({ ok: true }))
    // The hook ran first and owns the name; the later declaration is a default, so it yields.
    expect((await app.fetch(new Request("http://x/"))).headers.get("x-order")).toBe("hook")
    // And it did not silently become part of the static tier behind the hook.
    expect(responseHookCount(app)).toBe(2)
  })

  test("a declaration after a hook still applies to names the hook left alone", async () => {
    const app = server()
      .onResponseHeaders((headers) => headers.set("x-hook", "1"))
      .responseHeaders({ "x-late": "1" })
      .get("/", () => ({ ok: true }))
    const res = await app.fetch(new Request("http://x/"))
    expect(res.headers.get("x-hook")).toBe("1")
    expect(res.headers.get("x-late")).toBe("1")
  })

  test("merge() carries a group's declarations", async () => {
    const group = server()
      .responseHeaders({ "x-group": "1" })
      .get("/group", () => ({ ok: true }))
    const app = server()
      .responseHeaders({ "x-app": "1" })
      .merge(group)
      .get("/app", () => ({ ok: true }))
    for (const path of ["/group", "/app"]) {
      const res = await app.fetch(new Request(`http://x${path}`))
      expect(res.headers.get("x-group")).toBe("1")
      expect(res.headers.get("x-app")).toBe("1")
    }
    expect(responseHookCount(app)).toBe(0)
  })

  test("middleware can declare static headers through the bundle", async () => {
    const app = server()
      .use({ name: "static-mw", responseHeaders: { "x-mw": "1" } })
      .get("/", () => ({ ok: true }))
    expect((await app.fetch(new Request("http://x/"))).headers.get("x-mw")).toBe("1")
    expect(responseHookCount(app)).toBe(0)
  })
})

describe("responseHeaders() - refusals", () => {
  test("a non-string value throws", () => {
    expect(() => server().responseHeaders({ "x-a": 1 as unknown as string })).toThrow(TypeError)
  })

  test("an invalid header name throws", () => {
    expect(() => server().responseHeaders({ "x a": "1" })).toThrow(/valid header name/)
    expect(() => server().responseHeaders({ "": "1" })).toThrow(/valid header name/)
  })

  test("__proto__ throws instead of vanishing", () => {
    expect(() => server().responseHeaders({ ["__proto__"]: "x" })).toThrow(/__proto__/)
    expect(() => server().responseHeaders({ __PROTO__: "x" })).toThrow(/__proto__/)
  })

  test("a value with a newline throws", () => {
    expect(() => server().responseHeaders({ "x-a": "a\r\nx-b: c" })).toThrow(/control character/)
  })

  test("names the render owns throw", () => {
    for (const name of ["content-type", "content-length", "transfer-encoding", "set-cookie"]) {
      expect(() => server().responseHeaders({ [name]: "x" })).toThrow(/per response/)
    }
  })

  test("declaring after listen() is refused like every other configuration call", () => {
    const app = server().get("/", () => ({ ok: true }))
    const running = app.listen(0)
    try {
      expect(() => app.responseHeaders({ "x-a": "1" })).toThrow(/sealed/)
    } finally {
      running.stop()
    }
  })
})
