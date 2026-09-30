import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { RouteConfigError, server } from "../src/index.ts"
import { compileRoutePattern, expandOptionalParams } from "../src/router/pattern.ts"
import { Router } from "../src/router/router.ts"
import { defineContract, implement } from "../src/server/contract.ts"
import { websocket } from "../src/ws.ts"

const get = (path: string): Request => new Request(`http://t${path}`)

async function body(app: { fetch(request: Request): Response | Promise<Response> }, path: string) {
  const response = await app.fetch(get(path))
  return { status: response.status, body: (await response.json()) as unknown }
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    return error instanceof RouteConfigError ? error.code : `not a RouteConfigError: ${error}`
  }
  return undefined
}

describe("expandOptionalParams", () => {
  test("a trailing optional parameter is the path with and without it", () => {
    expect(expandOptionalParams("/users/:id?")).toEqual(["/users", "/users/:id"])
  })

  test("a run of n optional parameters is n + 1 prefix forms, shortest first", () => {
    expect(expandOptionalParams("/a/:b?/:c?/:d?")).toEqual([
      "/a",
      "/a/:b",
      "/a/:b/:c",
      "/a/:b/:c/:d",
    ])
  })

  test("the root's short form is `/`", () => {
    expect(expandOptionalParams("/:id?")).toEqual(["/", "/:id"])
    expect(expandOptionalParams("/:a?/:b?")).toEqual(["/", "/:a", "/:a/:b"])
  })

  test("a required parameter before the run stays required", () => {
    expect(expandOptionalParams("/orgs/:org/repos/:repo?")).toEqual([
      "/orgs/:org/repos",
      "/orgs/:org/repos/:repo",
    ])
  })

  test("only the trailing run expands: an earlier `?` stays literal text", () => {
    expect(expandOptionalParams("/a/:b?/c/:d?")).toEqual(["/a/:b?/c", "/a/:b?/c/:d"])
    expect(expandOptionalParams("/a/:b?/c")).toEqual(["/a/:b?/c"])
  })

  test.each([
    "/",
    "/users",
    "/users/:id",
    "/files/*path",
    "/users/:id?/",
    "/files/:name.:ext?",
    "/files/post-:id?",
    "/search?",
    "/a/:?",
    "/a/:9x?",
    "/a/:b??",
    "/a/*rest?",
    "",
    "?",
  ])("%p is not an optional-parameter path and comes back unchanged", (pattern) => {
    expect(expandOptionalParams(pattern)).toEqual([pattern])
  })

  test("every form of any generated run is a plain pattern, and the forms are its prefixes", () => {
    const name = fc.stringMatching(/^[a-z_][a-z0-9_]{0,6}$/)
    const names = fc.uniqueArray(name, { minLength: 1, maxLength: 6 })
    const head = fc.array(fc.stringMatching(/^[a-z0-9-]{1,6}$/), { maxLength: 3 })
    fc.assert(
      fc.property(head, names, (headSegments, params) => {
        const base = headSegments.map((segment) => `/${segment}`).join("")
        const forms = expandOptionalParams(`${base}${params.map((p) => `/:${p}?`).join("")}`)
        expect(forms).toHaveLength(params.length + 1)
        expect(forms[0]).toBe(base === "" ? "/" : base)
        for (let i = 1; i < forms.length; i++) {
          expect(forms[i]).toBe(
            `${base}${params
              .slice(0, i)
              .map((p) => `/:${p}`)
              .join("")}`,
          )
          expect(compileRoutePattern(forms[i]!).paramNames).toEqual(params.slice(0, i))
        }
        for (const form of forms) expect(form.includes("?")).toBe(false)
      }),
    )
  })

  test("a long run costs time in proportion to its length", () => {
    // 2000 optional segments: 2001 forms, built by one pass. Guards against a rewrite that builds
    // every subset, or re-scans the pattern per form.
    const pattern = `/x${Array.from({ length: 2000 }, (_, i) => `/:p${i}?`).join("")}`
    const started = performance.now()
    const forms = expandOptionalParams(pattern)
    expect(forms).toHaveLength(2001)
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe("optional route params", () => {
  test("one handler serves the path with and without the parameter", async () => {
    const app = server().get("/users/:id?", (c) => ({ id: c.params.id ?? null }))
    expect(await body(app, "/users")).toEqual({ status: 200, body: { id: null } })
    expect(await body(app, "/users/42")).toEqual({ status: 200, body: { id: "42" } })
  })

  test("an absent optional parameter is absent from `c.params`, not an empty string", async () => {
    const app = server().get("/users/:id?", (c) => ({ keys: Object.keys(c.params) }))
    expect((await body(app, "/users")).body).toEqual({ keys: [] })
    expect((await body(app, "/users/7")).body).toEqual({ keys: ["id"] })
  })

  test("a trailing slash is still a different path", async () => {
    const app = server().get("/users/:id?", () => ({ ok: true }))
    expect((await app.fetch(get("/users/"))).status).toBe(404)
    expect((await app.fetch(get("/users/1/"))).status).toBe(404)
    expect((await app.fetch(get("/users/1/2"))).status).toBe(404)
  })

  test("a run fills left to right", async () => {
    const app = server().get("/a/:b?/:c?", (c) => ({
      b: c.params.b ?? null,
      c: c.params.c ?? null,
    }))
    expect((await body(app, "/a")).body).toEqual({ b: null, c: null })
    expect((await body(app, "/a/1")).body).toEqual({ b: "1", c: null })
    expect((await body(app, "/a/1/2")).body).toEqual({ b: "1", c: "2" })
  })

  test("the values are percent-decoded like any parameter", async () => {
    const app = server().get("/tags/:tag?", (c) => ({ tag: c.params.tag ?? null }))
    expect((await body(app, "/tags/a%20b")).body).toEqual({ tag: "a b" })
    expect((await app.fetch(get("/tags/%E0%A4%A"))).status).toBe(400)
  })

  test("each form is an ordinary route: reflected, and a `405` with `Allow` per path", async () => {
    const app = server()
      .get("/users/:id?", () => ({ ok: true }))
      .delete("/users/:id", () => ({ ok: true }))
    expect(app.routes().map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /users",
      "GET /users/:id",
      "DELETE /users/:id",
    ])
    const short = await app.fetch(new Request("http://t/users", { method: "DELETE" }))
    expect(short.status).toBe(405)
    expect(short.headers.get("allow")).toBe("GET, HEAD")
    const long = await app.fetch(new Request("http://t/users/1", { method: "POST" }))
    expect(long.status).toBe(405)
    expect(long.headers.get("allow")).toBe("GET, DELETE, HEAD")
  })

  test("a static sibling still wins over the parameter form", async () => {
    const app = server()
      .get("/users/:id?", (c) => ({ id: c.params.id ?? null }))
      .get("/users/me", () => ({ id: "self" }))
    expect((await body(app, "/users/me")).body).toEqual({ id: "self" })
    expect((await body(app, "/users/you")).body).toEqual({ id: "you" })
  })

  test("the root can carry one", async () => {
    const app = server().get("/:lang?", (c) => ({ lang: c.params.lang ?? "en" }))
    expect((await body(app, "/")).body).toEqual({ lang: "en" })
    expect((await body(app, "/fr")).body).toEqual({ lang: "fr" })
  })

  test("inside a group the short form is the prefix itself", async () => {
    const app = server().group("/api", (api) =>
      api.get("/:id?", (c) => ({ id: c.params.id ?? null })),
    )
    expect(app.routes().map((route) => route.path)).toEqual(["/api", "/api/:id"])
    expect((await body(app, "/api")).body).toEqual({ id: null })
    expect((await body(app, "/api/9")).body).toEqual({ id: "9" })
    expect((await app.fetch(get("/api/"))).status).toBe(404)
  })

  test("a params schema validates what each form captured", async () => {
    const numeric = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (value: unknown) => {
          const id = (value as { id?: string }).id
          return id === undefined || /^\d+$/.test(id)
            ? { value: { id: id === undefined ? undefined : Number(id) } }
            : { issues: [{ message: "id must be numeric", path: ["id"] }] }
        },
      },
    }
    const app = server().get("/items/:id?", { params: numeric }, (c) => ({
      id: (c.params as { id?: number }).id ?? null,
    }))
    expect((await body(app, "/items")).body).toEqual({ id: null })
    expect((await body(app, "/items/12")).body).toEqual({ id: 12 })
    expect((await app.fetch(get("/items/abc"))).status).toBe(422)
  })

  test("a path one of the forms already serves is a duplicate, and nothing is registered", () => {
    const app = server().get("/users", () => ({ list: true }))
    expect(codeOf(() => app.get("/users/:id?", () => ({ ok: true })))).toBe("DUPLICATE_ROUTE")
    // Neither form survives the rejected registration - not even the one that was free.
    expect(app.routes().map((route) => route.path)).toEqual(["/users"])
    expect(codeOf(() => app.get("/users/:id", () => ({ ok: true })))).toBeUndefined()
  })

  test("a rejected long form takes the short form back out of the matcher", async () => {
    const app = server().get("/things/:thing", () => ({ one: true }))
    // The long form asks for a second name at a parameter position that already has one.
    expect(codeOf(() => app.get("/things/:id?", () => ({ ok: true })))).toBe("PARAM_NAME_CONFLICT")
    expect(app.routes().map((route) => route.path)).toEqual(["/things/:thing"])
    expect((await app.fetch(get("/things"))).status).toBe(404)
    expect((await body(app, "/things/1")).body).toEqual({ one: true })
  })

  test("a reserved or malformed name in the run is refused like any parameter name", () => {
    expect(codeOf(() => server().get("/a/:constructor?", () => ({})))).toBe("INVALID_PARAM_NAME")
    expect(codeOf(() => server().get("/a/:__proto__?", () => ({})))).toBe("INVALID_PARAM_NAME")
    expect(codeOf(() => server().get("/a/:b?/:b?", () => ({})))).toBe("DUPLICATE_PARAM")
  })

  test("a `?` that is not a trailing optional parameter keeps its literal meaning", async () => {
    const app = server()
      .get("/a/:b?/c", (c) => ({ b: c.params.b }))
      .get("/files/:name.:ext?", (c) => ({ name: c.params.name, ext: c.params.ext }))
    expect(app.routes().map((route) => route.path)).toEqual(["/a/:b?/c", "/files/:name.:ext?"])
    // No request path contains a raw `?`, so neither can match; nothing else changed about them.
    expect((await app.fetch(get("/a/c"))).status).toBe(404)
    expect((await app.fetch(get("/a/1/c"))).status).toBe(404)
    expect((await app.fetch(get("/files/readme"))).status).toBe(404)
  })

  test("every other verb takes one, and a body route validates on both forms", async () => {
    const app = server()
      .post("/notes/:id?", (c) => ({ id: c.params.id ?? null, body: c.body }))
      .put("/notes/:id?", (c) => ({ id: c.params.id ?? null }))
      .patch("/notes/:id?", (c) => ({ id: c.params.id ?? null }))
      .delete("/notes/:id?", (c) => ({ id: c.params.id ?? null }))
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const [path, id] of [
        ["/notes", null],
        ["/notes/3", "3"],
      ] as const) {
        const response = await app.fetch(
          new Request(`http://t${path}`, {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: "hi" }),
          }),
        )
        expect(response.status).toBe(200)
        expect(((await response.json()) as { id: unknown }).id).toBe(id)
      }
    }
  })

  test("a merged server carries both forms", async () => {
    const users = server().get("/users/:id?", (c) => ({ id: c.params.id ?? null }))
    const app = server().merge(users)
    expect((await body(app, "/users")).body).toEqual({ id: null })
    expect((await body(app, "/users/5")).body).toEqual({ id: "5" })
  })
})

describe("optional params in a contract", () => {
  const contract = defineContract({
    readUser: { method: "GET", path: "/users/:id?" },
    ping: { method: "GET", path: "/ping" },
  })

  test("`implement` serves both forms from the one handler", async () => {
    const app = implement(contract, {
      readUser: (c) => ({ id: c.params.id ?? null }),
      ping: () => ({ pong: true }),
    })
    expect(app.routes().map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /users",
      "GET /users/:id",
      "GET /ping",
    ])
    expect((await body(app, "/users")).body).toEqual({ id: null })
    expect((await body(app, "/users/8")).body).toEqual({ id: "8" })
  })

  test("two operations that serve one concrete path are a duplicate at definition", () => {
    expect(
      codeOf(() =>
        defineContract({
          list: { method: "GET", path: "/users" },
          read: { method: "GET", path: "/users/:id?" },
        }),
      ),
    ).toBe("DUPLICATE_ROUTE")
    expect(
      codeOf(() =>
        defineContract({
          list: { method: "POST", path: "/users" },
          read: { method: "GET", path: "/users/:id?" },
        }),
      ),
    ).toBeUndefined()
  })

  test("a rejected batch leaves the host app as it was", async () => {
    const host = server().get("/users/:id", () => ({ host: true }))
    // `:userId` cannot share the parameter position `:id` already names.
    const clash = defineContract({
      ping: { method: "GET", path: "/ping" },
      read: { method: "GET", path: "/users/:userId?" },
    })
    expect(
      codeOf(() =>
        implement(clash, { ping: () => ({ pong: true }), read: () => ({ ok: true }) }, host),
      ),
    ).toBe("PARAM_NAME_CONFLICT")
    expect(host.routes().map((route) => route.path)).toEqual(["/users/:id"])
    expect((await host.fetch(get("/ping"))).status).toBe(404)
    expect((await host.fetch(get("/users"))).status).toBe(404)
    expect((await body(host, "/users/1")).body).toEqual({ host: true })
  })
})

describe("Router.add and optional params", () => {
  test("one call is one route: the `?` is literal text until the caller expands it", () => {
    const router = new Router<string>()
    router.add("GET", "/users/:id?", "literal")
    expect(router.find("GET", "/users")).toEqual({ found: false, reason: "not-found" })
    expect(compileRoutePattern("/users/:id?").segments).toHaveLength(2)
  })

  test("adding each expanded pattern serves every form", () => {
    const router = new Router<string>()
    for (const form of expandOptionalParams("/docs/:lang?/:page?")) router.add("GET", form, "docs")
    expect(router.find("GET", "/docs")).toMatchObject({ found: true, payload: "docs", params: {} })
    expect(router.find("GET", "/docs/en")).toMatchObject({ found: true, params: { lang: "en" } })
    expect(router.find("GET", "/docs/en/intro")).toMatchObject({
      found: true,
      params: { lang: "en", page: "intro" },
    })
    expect(router.find("GET", "/docs/en/intro/x")).toEqual({ found: false, reason: "not-found" })
  })
})

describe("a WebSocket route with optional params", () => {
  const app = () =>
    server()
      .use(websocket())
      .ws<{ room: string }>("/rooms/:room?", {
        upgrade: (c) => ({ room: (c.params as { room?: string }).room ?? "lobby" }),
      })
  const upgrade = (path: string): Request =>
    new Request(`http://t${path}`, { headers: { upgrade: "websocket" } })

  test("upgrades with the param and without it", async () => {
    const withParam = await app().resolveWebSocketUpgrade(upgrade("/rooms/blue"))
    expect(withParam).toMatchObject({ kind: "upgrade", data: { room: "blue" } })
    const without = await app().resolveWebSocketUpgrade(upgrade("/rooms"))
    expect(without).toMatchObject({ kind: "upgrade", data: { room: "lobby" } })
  })

  test("a path past the run is not a WebSocket route", async () => {
    expect((await app().resolveWebSocketUpgrade(upgrade("/rooms/blue/x"))).kind).toBe("pass")
  })
})
