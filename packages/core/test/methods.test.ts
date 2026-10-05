import { describe, expect, test } from "bun:test"
import { connect } from "node:net"
import {
  defineAssurancePolicy,
  evaluateRouteAssurance,
  withRouteAssurance,
} from "../src/assurance.ts"
import {
  FrameworkError,
  type Middleware,
  RouteConfigError,
  type StandardSchemaV1,
  server,
} from "../src/index.ts"
import { isRegistrableMethod, METHODS, Router } from "../src/router/router.ts"
import { isRoutableMethod } from "../src/server/http.ts"
import { all, method } from "../src/server/methods.ts"

// A runtime's `Request` constructor normalizes or rejects an unusual method, so it cannot stand in
// for a transport that delivers the token as sent. Shadowing the accessor reproduces what such a
// transport hands the server.
function requestWith(name: string, url: string, init?: RequestInit): Request {
  const request = new Request(url, init)
  Object.defineProperty(request, "method", { value: name })
  return request
}

const listed = (app: { routes(): readonly { method: string; path: string }[] }): string[] =>
  app.routes().map((route) => `${route.method} ${route.path}`)

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run()
  } catch (error) {
    return error instanceof FrameworkError ? error.code : `threw ${String(error)}`
  }
  return undefined
}

const nameBody: StandardSchemaV1<unknown, { name: string }> = {
  "~standard": {
    version: 1,
    vendor: "methods-test",
    validate: (value: unknown) =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as { name?: unknown }).name === "string"
        ? { value: value as { name: string } }
        : { issues: [{ message: "name is required" }] },
  },
}

/** One request on a fresh connection, sent as written; resolves to `[status line, body]`. */
function raw(port: number, name: string, path: string): Promise<[string, string]> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`${name} ${path} HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n`)
    })
    let received = ""
    socket.on("data", (chunk) => {
      received += chunk
    })
    socket.on("close", () => {
      const split = received.indexOf("\r\n\r\n")
      resolve([received.slice(0, received.indexOf("\r\n")), received.slice(split + 4)])
    })
    socket.on("error", reject)
  })
}

describe("isRegistrableMethod", () => {
  test("accepts an uppercase token of letters, digits and hyphens, letter first, up to 32 chars", () => {
    for (const name of [...METHODS, "PROPFIND", "PURGE", "QUERY", "M-SEARCH", "X2", "BREW"]) {
      expect(isRegistrableMethod(name)).toBe(true)
    }
    expect(isRegistrableMethod("A".repeat(32))).toBe(true)
  })

  test("refuses TRACE, CONNECT and TRACK, and only those among well-formed tokens", () => {
    for (const name of ["TRACE", "CONNECT", "TRACK"]) expect(isRegistrableMethod(name)).toBe(false)
    for (const name of ["TRACER", "TRAC", "CONNECTED", "TRACKS", "X-TRACE", "TRACE-X"]) {
      expect(isRegistrableMethod(name)).toBe(true)
    }
  })

  test("refuses anything that is not such a token", () => {
    for (const name of ["", "get", "Get", "GE T", "GET ", "-GET", "9GET", "G_T", "GÉT", "GET\n"]) {
      expect(isRegistrableMethod(name)).toBe(false)
    }
    expect(isRegistrableMethod("A".repeat(33))).toBe(false)
  })

  // The request-side check decides which tokens reach routing at all. A method that can be
  // registered but never routed would be a dead route; one that can be routed but not registered is
  // only ever a `405`. The two agree everywhere except the three refused names.
  test("agrees with the request-side token check, apart from the refused names", () => {
    const samples = [
      ...METHODS,
      "PROPFIND",
      "M-SEARCH",
      "X2",
      "A".repeat(32),
      "A".repeat(33),
      "",
      "get",
      "GE T",
      "-GET",
      "9GET",
      "G_T",
      "GÉT",
      "GET\n",
      "A-",
      "A--B",
    ]
    for (const name of samples) expect(isRegistrableMethod(name)).toBe(isRoutableMethod(name))
    for (const name of ["TRACE", "CONNECT", "TRACK"]) {
      expect(isRoutableMethod(name)).toBe(true)
      expect(isRegistrableMethod(name)).toBe(false)
    }
  })
})

describe("Router.add and method names", () => {
  test("registers a custom token and matches it exactly", () => {
    const router = new Router<string>()
    router.add("PROPFIND", "/dav", "listing")
    router.add("purge", "/cache/:key", "purge")
    expect(router.find("PROPFIND", "/dav")).toMatchObject({ found: true, payload: "listing" })
    expect(router.find("PURGE", "/cache/k")).toMatchObject({ found: true, payload: "purge" })
    expect(router.find("propfind", "/dav")).toMatchObject({
      found: false,
      reason: "method-not-allowed",
    })
    expect(router.find("GET", "/dav")).toMatchObject({
      found: false,
      reason: "method-not-allowed",
      allowed: ["PROPFIND"],
    })
  })

  test("refuses TRACE, CONNECT and TRACK in any casing, and a malformed name", () => {
    for (const name of ["TRACE", "trace", "Connect", "TRACK", "track", "GE T", "", "9X"]) {
      expect(codeOf(() => new Router<string>().add(name, "/x", "x"))).toBe("INVALID_METHOD")
    }
  })
})

describe("all()", () => {
  test("serves the path under every standard method and lists each as a route", async () => {
    const app = server().use(all("/echo/:id", (c) => ({ method: c.req.method, id: c.params.id })))
    expect(listed(app)).toEqual(METHODS.map((name) => `${name} /echo/:id`))
    for (const name of METHODS) {
      // Repeated so the dynamic match cache is exercised as well as the first walk.
      for (let i = 0; i < 2; i++) {
        const response = await app.fetch(new Request("http://t/echo/7", { method: name }))
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ method: name, id: "7" })
      }
    }
  })

  test("is not a catch-all: another method on the path is a 405 naming the seven", async () => {
    const app = server().use(all("/echo", () => "ok"))
    for (const name of ["PROPFIND", "TRACE", "CONNECT", "BREW"]) {
      const response = await app.fetch(requestWith(name, "http://t/echo"))
      expect(response.status).toBe(405)
      expect(response.headers.get("allow")).toBe(METHODS.join(", "))
    }
    // A token that cannot be a method at all is answered the same way, without running the handler.
    for (const name of ["get", "Post", "GE T"]) {
      expect((await app.fetch(requestWith(name, "http://t/echo"))).status).toBe(405)
    }
    expect((await app.fetch(new Request("http://t/other"))).status).toBe(404)
  })

  test("a schema applies to every method", async () => {
    const app = server().use(all("/named", { body: nameBody }, (c) => ({ name: c.body.name })))
    const post = await app.fetch(
      new Request("http://t/named", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "ada" }),
      }),
    )
    expect(post.status).toBe(200)
    expect(await post.json()).toEqual({ name: "ada" })
    const invalid = await app.fetch(
      new Request("http://t/named", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: 1 }),
      }),
    )
    expect(invalid.status).toBe(422)
    // A request with no body is refused rather than reaching the handler.
    expect((await app.fetch(new Request("http://t/named"))).status).toBe(415)
  })

  test("a method already registered on the path refuses the whole call", async () => {
    const app = server().post("/a", () => "first")
    expect(codeOf(() => app.use(all("/a", () => "second")))).toBe("DUPLICATE_ROUTE")
    expect(listed(app)).toEqual(["POST /a"])
    expect((await app.fetch(new Request("http://t/a"))).status).toBe(405)
    const post = await app.fetch(new Request("http://t/a", { method: "POST" }))
    expect(await post.json()).toBe("first")
  })

  test("a method registered afterwards on the same path is a duplicate", () => {
    const app = server().use(all("/a", () => "all"))
    expect(codeOf(() => app.get("/a", () => "get"))).toBe("DUPLICATE_ROUTE")
    expect(codeOf(() => app.use(all("/a", () => "again")))).toBe("DUPLICATE_ROUTE")
    expect(listed(app).length).toBe(METHODS.length)
  })

  test("takes optional params: each form is served under every method", async () => {
    const app = server().use(all("/o/:a?", (c) => ({ a: c.params.a ?? null })))
    expect(listed(app).length).toBe(METHODS.length * 2)
    expect(await (await app.fetch(new Request("http://t/o", { method: "PATCH" }))).json()).toEqual({
      a: null,
    })
    expect(
      await (await app.fetch(new Request("http://t/o/x", { method: "DELETE" }))).json(),
    ).toEqual({ a: "x" })
  })

  test("inside a group it takes the group's prefix and hooks", async () => {
    const seen: string[] = []
    const app = server().group("/api", (api) =>
      api
        .derive((c) => {
          seen.push(c.req.method)
          return { tenant: "t1" }
        })
        .use(all("/ping", (c) => ({ tenant: c.tenant }))),
    )
    expect(listed(app)).toEqual(METHODS.map((name) => `${name} /api/ping`))
    const response = await app.fetch(new Request("http://t/api/ping", { method: "PUT" }))
    expect(await response.json()).toEqual({ tenant: "t1" })
    expect(seen).toEqual(["PUT"])
    expect((await app.fetch(new Request("http://t/ping"))).status).toBe(404)
  })

  test("a call without a handler function is refused where it is written", () => {
    expect(() => all("/x", undefined as never)).toThrow(TypeError)
    expect(() => all("/x", { body: nameBody }, undefined as never)).toThrow(TypeError)
  })
})

describe("method()", () => {
  test("serves a custom method, on static, param and wildcard paths", async () => {
    const app = server()
      .use(method("REPORT", "/static", () => "report"))
      .use(method("PURGE", "/cache/:key", (c) => ({ key: c.params.key })))
      .use(method("PROPFIND", "/dav/*path", (c) => ({ path: c.params.path })))
    expect(listed(app)).toEqual(["REPORT /static", "PURGE /cache/:key", "PROPFIND /dav/*path"])
    for (let i = 0; i < 2; i++) {
      expect(await (await app.fetch(requestWith("REPORT", "http://t/static"))).json()).toBe(
        "report",
      )
      expect(await (await app.fetch(requestWith("PURGE", "http://t/cache/k"))).json()).toEqual({
        key: "k",
      })
      expect(await (await app.fetch(requestWith("PROPFIND", "http://t/dav/a/b"))).json()).toEqual({
        path: "a/b",
      })
    }
  })

  test("a name is case-insensitive at registration, exact at request time", async () => {
    const app = server().use(method("purge", "/cache", (c) => c.req.method))
    expect(listed(app)).toEqual(["PURGE /cache"])
    expect((await app.fetch(requestWith("PURGE", "http://t/cache"))).status).toBe(200)
    for (const name of ["purge", "Purge"]) {
      const response = await app.fetch(requestWith(name, "http://t/cache"))
      expect(response.status).toBe(405)
      expect(response.headers.get("allow")).toBe("PURGE")
    }
  })

  test("a list registers each method, standard or not", async () => {
    const app = server().use(
      method(["PURGE", "delete"], "/cache/:key", (c) => ({ method: c.req.method })),
    )
    expect(listed(app)).toEqual(["PURGE /cache/:key", "DELETE /cache/:key"])
    const purge = await app.fetch(requestWith("PURGE", "http://t/cache/k"))
    expect(await purge.json()).toEqual({ method: "PURGE" })
    const del = await app.fetch(new Request("http://t/cache/k", { method: "DELETE" }))
    expect(await del.json()).toEqual({ method: "DELETE" })
    const get = await app.fetch(new Request("http://t/cache/k"))
    expect(get.status).toBe(405)
    expect(get.headers.get("allow")).toBe("PURGE, DELETE")
  })

  test("a custom method beside a standard one on the same path: each answers its own", async () => {
    const app = server()
      .get("/doc", () => "get")
      .use(method("REPORT", "/doc", () => "report"))
    expect(await (await app.fetch(new Request("http://t/doc"))).json()).toBe("get")
    expect(await (await app.fetch(requestWith("REPORT", "http://t/doc"))).json()).toBe("report")
    // HEAD is still derived from GET, and only from GET.
    expect((await app.fetch(new Request("http://t/doc", { method: "HEAD" }))).status).toBe(200)
    const post = await app.fetch(new Request("http://t/doc", { method: "POST" }))
    expect(post.status).toBe(405)
    expect(post.headers.get("allow")).toBe("GET, REPORT, HEAD")
  })

  test("a custom method alone does not answer HEAD", async () => {
    const app = server().use(method("REPORT", "/doc", () => "report"))
    const head = await app.fetch(new Request("http://t/doc", { method: "HEAD" }))
    expect(head.status).toBe(405)
    expect(head.headers.get("allow")).toBe("REPORT")
  })

  test("a schema validates a custom method's body", async () => {
    const app = server().use(
      method("PATCH-ALL", "/bulk", { body: nameBody }, (c) => ({ name: c.body.name })),
    )
    const init = { method: "POST", headers: { "content-type": "application/json" } }
    const ok = await app.fetch(
      requestWith("PATCH-ALL", "http://t/bulk", { ...init, body: JSON.stringify({ name: "a" }) }),
    )
    expect(await ok.json()).toEqual({ name: "a" })
    const invalid = await app.fetch(
      requestWith("PATCH-ALL", "http://t/bulk", { ...init, body: JSON.stringify({}) }),
    )
    expect(invalid.status).toBe(422)
  })

  test("TRACE, CONNECT and TRACK are refused in any casing, alone or in a list", () => {
    for (const name of ["TRACE", "trace", "Trace", "CONNECT", "connect", "TRACK", "track"]) {
      expect(codeOf(() => method(name, "/x", () => 1))).toBe("INVALID_METHOD")
      expect(codeOf(() => method(["GET", name], "/x", () => 1))).toBe("INVALID_METHOD")
    }
  })

  test("a name that is not a method token is refused when method() is called", () => {
    const bad: unknown[] = [
      "",
      "GE T",
      "GET ",
      "9X",
      "-X",
      "G_T",
      "GÉT",
      "GET\n",
      "A".repeat(33),
      // Letters outside ASCII that fold to ASCII ones are not a spelling of the ASCII name.
      "optıons",
      "straße",
      5,
      null,
      undefined,
      {},
      [],
      [5],
      ["GET", ""],
    ]
    for (const name of bad) {
      const error = (() => {
        try {
          method(name as never, "/x", () => 1)
        } catch (thrown) {
          return thrown
        }
        return undefined
      })()
      expect(error).toBeInstanceOf(RouteConfigError)
      expect((error as RouteConfigError).code).toBe("INVALID_METHOD")
    }
  })

  test("a refused list adds nothing, and a duplicate in it refuses the whole call", () => {
    const app = server().get("/a", () => "get")
    expect(codeOf(() => app.use(method(["PURGE", "GET"], "/a", () => 1)))).toBe("DUPLICATE_ROUTE")
    expect(codeOf(() => app.use(method(["PURGE", "purge"], "/b", () => 1)))).toBe("DUPLICATE_ROUTE")
    expect(listed(app)).toEqual(["GET /a"])
  })

  test("the path is validated like any route path", () => {
    expect(codeOf(() => server().use(method("PURGE", "no-slash", () => 1)))).toBe("INVALID_PATH")
  })

  test("route hooks and derived context reach a custom-method handler", async () => {
    const order: string[] = []
    const app = server()
      .derive(() => ({ user: "u1" }))
      .beforeHandle(() => {
        order.push("before")
      })
      .use(
        method("PURGE", "/cache", (c) => {
          order.push("handler")
          return { user: c.user }
        }),
      )
    const response = await app.fetch(requestWith("PURGE", "http://t/cache"))
    expect(await response.json()).toEqual({ user: "u1" })
    expect(order).toEqual(["before", "handler"])
  })

  test("a merged server carries a custom-method route", async () => {
    const child = server().use(method("PURGE", "/cache", () => "purged"))
    const app = server().merge(child)
    expect(listed(app)).toEqual(["PURGE /cache"])
    expect(await (await app.fetch(requestWith("PURGE", "http://t/cache"))).json()).toBe("purged")
  })
})

describe("all() and method(): after listen()", () => {
  test("registration is refused", async () => {
    const app = server().get("/", () => "home")
    const running = app.listen(0, { hostname: "127.0.0.1" })
    try {
      expect(codeOf(() => app.use(all("/late", () => 1)))).toBe("SERVER_SEALED")
      expect(codeOf(() => app.use(method("PURGE", "/late", () => 1)))).toBe("SERVER_SEALED")
      expect(listed(app)).toEqual(["GET /"])
    } finally {
      await running.stop()
    }
  })

  test("a listening server serves a custom method beside the standard ones", async () => {
    const app = server()
      .get("/doc", () => "get")
      .use(method("PROPFIND", "/doc", () => "propfind"))
      .use(method("PURGE", "/cache/:key", (c) => ({ key: c.params.key })))
      .use(all("/echo", (c) => c.req.method))
    const running = app.listen(0, { hostname: "127.0.0.1" })
    try {
      const { port } = running
      expect(await raw(port, "GET", "/doc")).toEqual(["HTTP/1.1 200 OK", '"get"'])
      expect(await raw(port, "PROPFIND", "/doc")).toEqual(["HTTP/1.1 200 OK", '"propfind"'])
      expect(await raw(port, "PURGE", "/cache/k")).toEqual(["HTTP/1.1 200 OK", '{"key":"k"}'])
      expect((await raw(port, "REPORT", "/doc"))[0]).toBe("HTTP/1.1 405 Method Not Allowed")
      for (const name of ["POST", "DELETE", "OPTIONS"]) {
        expect(await raw(port, name, "/echo")).toEqual(["HTTP/1.1 200 OK", `"${name}"`])
      }
      // An explicit HEAD route answers with headers only on the wire.
      expect(await raw(port, "HEAD", "/echo")).toEqual(["HTTP/1.1 200 OK", ""])
      // TRACE reaches the app on this transport and finds no route: it cannot be registered.
      expect((await raw(port, "TRACE", "/echo"))[0]).toBe("HTTP/1.1 405 Method Not Allowed")
    } finally {
      await running.stop()
    }
  })
})

describe("all() and method(): assurance", () => {
  const guard = withRouteAssurance<Middleware>({ name: "guard", onRequest: () => undefined }, [
    { id: "test.authenticated", source: "guard", scope: "global", methods: ["POST", "DELETE"] },
  ])

  test("a method-scoped declaration reaches exactly the expanded routes it names", () => {
    const app = server()
      .use(guard)
      .use(all("/echo", () => 1))
    const carrying = app
      .routes()
      .filter((route) => route.assurance?.some((item) => item.id === "test.authenticated"))
      .map((route) => route.method)
    expect(carrying).toEqual(["POST", "DELETE"])
  })

  test("a custom-method route is unclassified by method-scoped rules: the policy fails", () => {
    const policy = defineAssurancePolicy({
      rules: [
        {
          name: "writes",
          match: { methods: ["POST", "PUT", "PATCH", "DELETE"] },
          require: ["test.authenticated"],
        },
        { name: "reads", match: { methods: ["GET", "HEAD", "OPTIONS"] }, require: [] },
      ],
    })
    const app = server()
      .use(guard)
      .use(method("PURGE", "/cache/:key", () => 1))
    const report = evaluateRouteAssurance(app, policy)
    expect(report.ok).toBe(false)
    expect(report.findings).toEqual([
      expect.objectContaining({
        code: "unclassified-route",
        method: "PURGE",
        path: "/cache/:key",
      }),
    ])
  })

  test("a rule that selects by path classifies it and asks for its evidence", () => {
    const policy = defineAssurancePolicy({
      rules: [{ name: "cache", match: { paths: ["/cache/**"] }, require: ["test.authenticated"] }],
    })
    const app = server()
      .use(guard)
      .use(method("PURGE", "/cache/:key", () => 1))
    // The guard's evidence is scoped to POST and DELETE, so the PURGE route does not carry it.
    expect(evaluateRouteAssurance(app, policy).findings).toEqual([
      expect.objectContaining({
        code: "missing-evidence",
        method: "PURGE",
        path: "/cache/:key",
        evidence: "test.authenticated",
      }),
    ])

    const everywhere = withRouteAssurance<Middleware>(
      { name: "everywhere", onRequest: () => undefined },
      { id: "test.authenticated", source: "everywhere", scope: "global" },
    )
    const covered = server()
      .use(everywhere)
      .use(method("PURGE", "/cache/:key", () => 1))
    expect(evaluateRouteAssurance(covered, policy)).toMatchObject({ ok: true, findings: [] })
  })

  test("a policy cannot select a custom method by name", () => {
    expect(() =>
      defineAssurancePolicy({
        rules: [{ name: "purge", match: { methods: ["PURGE" as never] }, require: [] }],
      }),
    ).toThrow()
  })
})
