import { describe, expect, test } from "bun:test"
import { authenticated, rejected, server } from "../src/index.ts"
import { method as route } from "../src/server/methods.ts"
import {
  INVALID_HOSTS,
  invalidHostMismatches,
  PARSEABLE_INVALID_HOSTS,
  REPEATED_HOSTS,
  rawExchange,
  refusedHostMismatches,
  requestTargetApp,
  requestTargetMismatches,
} from "./request-target-matrix.ts"

/**
 * `listen()` on Bun hands some routes to Bun's own route table. These tests hold that lane to the
 * portable router's answer: whichever route `app.fetch` picks for a request, `listen()` picks too.
 */

/** The part of a server these tests drive. */
interface Served {
  listen(
    port: number,
    options: { readonly hostname: string },
  ): { readonly port: number; stop(closeActiveConnections?: boolean): void }
  fetch(request: Request): Response | Promise<Response>
}
type BareServer = ReturnType<typeof server>
type NativeHandler = () => Response
type NativeTable = Record<string, Record<string, NativeHandler>> | undefined

/**
 * The routes served from Bun's table, as `METHOD /path`. The table also carries the portable
 * dispatcher under every method it does not serve itself; those entries are left out.
 */
function nativeKeys(app: object): string[] {
  const portable: NativeHandler = () => new Response(null)
  // Inspect the private builder without invoking the handlers it compiles.
  const table =
    (
      app as {
        buildBunNativeRoutes(
          fallback: NativeHandler,
          peer: object,
          platformFor: () => object,
        ): NativeTable
      }
    ).buildBunNativeRoutes(portable, {}, () => ({})) ?? {}
  return Object.keys(table)
    .flatMap((path) =>
      Object.keys(table[path]!)
        .filter((method) => table[path]![method] !== portable)
        .map((method) => `${method} ${path}`),
    )
    .sort()
}

function register(app: BareServer, method: string, path: string): BareServer {
  const handler = (c: { params: unknown }) => ({ route: `${method} ${path}`, params: c.params })
  return app.use(route(method, path, handler)) as unknown as BareServer
}

async function answers(
  app: Served,
  requests: readonly (readonly [method: string, path: string, init?: RequestInit])[],
): Promise<{ listened: string[]; fetched: string[] }> {
  // A HEAD answer has no body on the wire, so the two lanes are compared on what both can show.
  const show = async (label: string, response: Response): Promise<string> =>
    `${label} -> ${response.status} allow=${response.headers.get("allow")} ${
      label.startsWith("HEAD") ? "" : await response.text()
    }`
  // Bound to the loopback address itself: a port picked for every interface can be one another
  // process already holds on loopback, and that process would get these requests.
  const instance = app.listen(0, { hostname: "127.0.0.1" })
  // Probes are independent, so they go out together: one at a time, the generated-table test's
  // ~80k loopback round trips outran its budget on a loaded machine.
  try {
    const listened = await Promise.all(
      requests.map(async ([method, path, init]) =>
        show(
          `${method} ${path}`,
          await fetch(`http://127.0.0.1:${instance.port}${path}`, { ...init, method }),
        ),
      ),
    )
    const fetched = await Promise.all(
      requests.map(async ([method, path, init]) =>
        show(
          `${method} ${path}`,
          await app.fetch(new Request(`http://x${path}`, { ...init, method })),
        ),
      ),
    )
    return { listened, fetched }
  } finally {
    instance.stop(true)
  }
}

describe("Bun-native route table agrees with the portable router", () => {
  test("a composed mount keeps only paths it may reach off the native table", async () => {
    const app = server()
      .mount({ path: "/api", app: { fetch: () => Response.json({ source: "mount" }) } })
      .get("/", () => ({ source: "home" }))
      .get("/health", () => ({ source: "health" }))
      .get("/api", () => ({ source: "parent" }))
      .get("/api/health", () => ({ source: "parent" }))
      .get("/api2", () => ({ source: "sibling" }))
      .get("/users/:id", (c) => ({ id: c.params.id }))
      .post("/users", () => ({ source: "created" }))
      .get("/:area/ping", (c) => ({ area: c.params.area }))
    expect(nativeKeys(app)).toEqual([
      "GET /",
      "GET /api2",
      "GET /health",
      "GET /users/:id",
      "HEAD /",
      "HEAD /api2",
      "HEAD /health",
      "HEAD /users/:id",
      "POST /users",
    ])
    const { listened, fetched } = await answers(app, [
      ["GET", "/"],
      ["GET", "/api"],
      ["GET", "/api/health"],
      ["GET", "/api/missing"],
      ["GET", "/api2"],
      ["GET", "/users/7"],
      ["HEAD", "/users/7"],
      ["POST", "/users"],
      ["POST", "/api/health"],
      ["OPTIONS", "/api/health"],
      ["DELETE", "/users/7"],
      ["GET", "/api/ping"],
      ["GET", "/docs/ping"],
    ])
    expect(listened).toEqual(fetched)
    expect(listened[1]).toContain('{"source":"mount"}')
    expect(listened[4]).toContain('{"source":"sibling"}')
    expect(listened[10]).toContain("-> 405 allow=GET, HEAD")
    expect(listened[11]).toContain('{"source":"mount"}')
  })

  test("an ancestor's static route stays native but its param route may reach a nested mount", async () => {
    const app = server()
      .mount({ path: "/users/admin", app: { fetch: () => new Response("mounted admin") } })
      .get("/users", () => "users")
      .get("/users/:id", (c) => c.params.id)
      .get("/users/public/:id", (c) => c.params.id)
      .get("/users/admin/:id", () => "parent admin")
    expect(nativeKeys(app)).toEqual([
      "GET /users",
      "GET /users/public/:id",
      "HEAD /users",
      "HEAD /users/public/:id",
    ])
    const { listened, fetched } = await answers(app, [
      ["GET", "/users"],
      ["GET", "/users/ada"],
      ["GET", "/users/admin"],
      ["GET", "/users/admin/7"],
      ["GET", "/users/public/7"],
      ["HEAD", "/users/public/7"],
    ])
    expect(listened).toEqual(fetched)
    expect(listened[2]).toContain("mounted admin")
  })

  test("normalized mount prefixes keep their boundary and root mounts keep every route portable", () => {
    for (const path of ["/api/", "/api/*"]) {
      const app = server()
        .mount({ path, app: { fetch: () => new Response("mounted") } })
        .get("/api", () => "parent")
        .get("/api/x", () => "parent")
        .get("/api2", () => "sibling")
      expect(nativeKeys(app)).toEqual(["GET /api2", "HEAD /api2"])
    }
    for (const path of ["/", "/*"]) {
      expect(
        nativeKeys(
          server()
            .mount({ path, app: { fetch: () => new Response("mounted") } })
            .get("/health", () => "parent")
            .post("/users", () => "parent"),
        ),
      ).toEqual([])
    }
  })

  test("disjoint native routes do not bypass mount authentication or prefix stripping", async () => {
    const child = server().get("/hello", () => "child")
    const app = server()
      .get("/health", () => "public")
      .authenticate({
        id: "token",
        mode: "sync",
        run: (input) =>
          input.headers.get("authorization") === "Bearer ok"
            ? authenticated({ id: "u1" })
            : rejected("unauthenticated"),
      })
      .mount({ path: "/api", app: child, stripPrefix: true })
      .get("/api/hello", () => "parent")
    expect(nativeKeys(app)).toEqual(["GET /health", "HEAD /health"])
    const { listened, fetched } = await answers(app, [
      ["GET", "/health"],
      ["GET", "/api/hello"],
      ["GET", "/api/hello", { headers: { authorization: "Bearer ok" } }],
    ])
    expect(listened).toEqual(fetched)
    expect(listened[1]).toContain("-> 401")
    expect(listened[2]).toContain('"child"')
  })

  test("sync and async request rewrites into a mount still run mounts and hooks once", async () => {
    const calls: string[] = []
    const app = server()
      .onRequest((req) => {
        const path = new URL(req.url).pathname
        calls.push(path)
        return path === "/rewrite" ? new Request(new URL("/api/hello", req.url), req) : undefined
      })
      .onRequest(async (req) =>
        new URL(req.url).pathname === "/async-rewrite"
          ? new Request(new URL("/api/hello", req.url), req)
          : undefined,
      )
      .mount({ path: "/api", app: { fetch: () => new Response("mounted") } })
      .get("/rewrite", () => "parent")
      .get("/async-rewrite", () => "parent")
      .get("/health", () => "health")
    expect(nativeKeys(app)).toContain("GET /rewrite")
    const { listened, fetched } = await answers(app, [
      ["GET", "/rewrite"],
      ["GET", "/async-rewrite"],
      ["GET", "/health"],
    ])
    expect(listened).toEqual(fetched)
    expect(listened[0]).toContain("mounted")
    expect(listened[1]).toContain("mounted")
    expect(calls.filter((path) => path === "/rewrite")).toHaveLength(2)
    expect(calls.filter((path) => path === "/async-rewrite")).toHaveLength(2)
    expect(calls).toHaveLength(6)
  })

  test("mixed mount and route tables preserve precedence on every request method", async () => {
    const paths = [
      "/",
      "/health",
      "/api",
      "/api/health",
      "/api/missing",
      "/api2",
      "/api2/ping",
      "/users",
      "/users/7",
      "/users/admin",
      "/users/admin/7",
      "/users/public/7",
      "/users/%2F",
      "/users/%ff",
      "/docs/ping",
      "/docs/a.json",
      "/nope",
    ]
    const methods = ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS", "PURGE"]
    const probes = paths.flatMap((path) => methods.map((method) => [method, path] as const))
    for (const prefix of ["/api", "/users/admin", "/api2", "/api/health", "/elsewhere", "/"]) {
      const app = server()
        .mount({ path: prefix, app: { fetch: () => new Response("mounted") } })
        .get("/", () => "home")
        .get("/health", () => "health")
        .post("/api/health", () => "api parent")
        .get("/api2", () => "api sibling")
        .post("/users", () => "users")
        .get("/users/:id", (c) => c.params.id)
        .post("/users/admin", () => "admin")
        .get("/users/public/:id", (c) => c.params.id)
        .get("/:area/ping", (c) => c.params.area)
        .get("/docs/:name.json", (c) => c.params.name)
        .get("/*rest", (c) => c.params.rest)
      const { listened, fetched } = await answers(app, probes)
      expect(listened).toEqual(fetched)
    }
  })

  test("a wildcard route under a static prefix keeps its requests from a broader param route", async () => {
    const app = server()
      .get("/admin/*rest", (c) => ({ route: "admin", rest: c.params.rest }))
      .get("/:section/:page", (c) => ({ route: "page", params: c.params }))
    const { listened, fetched } = await answers(app, [
      ["GET", "/admin/users"],
      ["GET", "/docs/intro"],
    ])
    expect(listened).toEqual(fetched)
    expect(listened[0]).toContain('"route":"admin"')
    expect(listened[1]).toContain('"route":"page"')
  })

  test("a method miss on the more specific route is a 405, not a less specific route", async () => {
    const app = server()
      .post("/users/me", () => ({ route: "me" }))
      .get("/users/:id", (c) => ({ route: "id", id: c.params.id }))
    const { listened, fetched } = await answers(app, [
      ["GET", "/users/me"],
      ["HEAD", "/users/me"],
      ["POST", "/users/me"],
      ["GET", "/users/7"],
    ])
    expect(listened).toEqual(fetched)
    expect(listened[0]).toContain("-> 405 allow=POST")
    expect(listened[3]).toContain('"id":"7"')
  })

  test("a path with non-ASCII characters is served from the table under its encoded spelling", async () => {
    const app = server()
      .get("/café", () => ({ route: "cafe" }))
      .get("/日本/:id", (c) => ({ route: "nihon", id: c.params.id }))
      .get("/:name", (c) => ({ route: "name", name: c.params.name }))
    expect(nativeKeys(app)).toContain("GET /caf%C3%A9")
    const { listened, fetched } = await answers(app, [
      ["GET", encodeURI("/café")],
      ["GET", encodeURI("/日本/7")],
      ["GET", "/cafe"],
    ])
    expect(listened).toEqual(fetched)
    expect(listened[0]).toContain('"route":"cafe"')
    expect(listened[1]).toContain('"id":"7"')
    expect(listened[2]).toContain('"route":"name"')
  })

  test("a part-literal segment is matched as written and outranks a bare parameter", async () => {
    const app = server()
      .get("/files/:name.json", (c) => ({ route: "json", params: c.params }))
      .get("/files/:name", (c) => ({ route: "any", params: c.params }))
      .get("/docs/:page.md", (c) => ({ route: "md", params: c.params }))
    const { listened, fetched } = await answers(app, [
      ["GET", "/files/a.json"],
      ["GET", "/files/a"],
      ["GET", "/files/a.jsonx"],
      ["GET", "/docs/intro.md"],
      ["GET", "/docs/intro"],
      ["GET", "/docs/intro.mdx"],
    ])
    expect(listened).toEqual(fetched)
    expect(listened[0]).toContain('"route":"json","params":{"name":"a"}')
    expect(listened[1]).toContain('"route":"any","params":{"name":"a"}')
    expect(listened[3]).toContain('"route":"md","params":{"page":"intro"}')
    expect(listened[4]).toContain("-> 404")
    expect(listened[5]).toContain("-> 404")
  })

  test("a constrained parameter is matched by the portable router and outranks a bare one", async () => {
    const app = server()
      .get("/users/:id{[0-9]+}", (c) => ({ route: "numeric", params: c.params }))
      .post("/users/:id{[0-9]+}", (c) => ({ route: "update", params: c.params }))
      .get("/users/:name", (c) => ({ route: "name", params: c.params }))
      .get("/img/:kind{thumb|full}", (c) => ({ route: "kind", params: c.params }))
      .get("/o/:page{[0-9]+}?", (c) => ({ route: "page", params: c.params }))
    const { listened, fetched } = await answers(app, [
      ["GET", "/users/42"],
      ["GET", "/users/ada"],
      ["GET", "/users/4%32"],
      ["POST", "/users/42"],
      ["POST", "/users/ada"],
      ["DELETE", "/users/42"],
      ["HEAD", "/users/42"],
      ["GET", "/img/thumb"],
      ["GET", "/img/other"],
      ["GET", "/o"],
      ["GET", "/o/3"],
      ["GET", "/o/x"],
    ])
    expect(listened).toEqual(fetched)
    expect(listened[0]).toContain('"route":"numeric","params":{"id":"42"}')
    expect(listened[1]).toContain('"route":"name","params":{"name":"ada"}')
    expect(listened[2]).toContain('"route":"name","params":{"name":"42"}')
    expect(listened[3]).toContain('"route":"update"')
    expect(listened[4]).toContain("-> 405 allow=GET, HEAD")
    expect(listened[5]).toContain("-> 405 allow=GET, POST, HEAD")
    expect(listened[8]).toContain("-> 404")
    expect(listened[9]).toContain('"route":"page","params":{}')
    expect(listened[10]).toContain('"route":"page","params":{"page":"3"}')
    expect(listened[11]).toContain("-> 404")

    // A constrained path is never in Bun's table, and the bare parameter it outranks leaves with it.
    expect(nativeKeys(app)).toEqual(["GET /o", "HEAD /o"])
  })

  test("a path is served from the table unless a path outside the table outranks it", () => {
    expect(
      nativeKeys(
        server()
          .get("/users/me", () => 1)
          .get("/users/:id", () => 2)
          .post("/users", () => 3),
      ),
    ).toEqual([
      "GET /users/:id",
      "GET /users/me",
      "HEAD /users/:id",
      "HEAD /users/me",
      "POST /users",
    ])

    // A static sibling under another method costs the param route nothing: the sibling's path is in
    // the table under every method, so Bun stops there and the portable router answers the 405.
    expect(
      nativeKeys(
        server()
          .post("/users/me", () => 1)
          .get("/users/:id", () => 2),
      ),
    ).toEqual(["GET /users/:id", "HEAD /users/:id", "POST /users/me"])
    expect(
      nativeKeys(
        server()
          .post("/a/b", () => 1)
          .get("/a/:x", () => 2)
          .get("/:p/:q", () => 3),
      ),
    ).toEqual(["GET /:p/:q", "GET /a/:x", "HEAD /:p/:q", "HEAD /a/:x", "POST /a/b"])

    // An explicit HEAD route is served as registered; a GET answers HEAD on its own path.
    expect(
      nativeKeys(
        server()
          .get("/users/me", () => 1)
          .use(route("HEAD", "/users/:id", () => 2)),
      ),
    ).toEqual(["GET /users/me", "HEAD /users/:id", "HEAD /users/me"])

    // A method outside the standard seven has no slot in the table; its path is there all the same.
    expect(
      nativeKeys(
        server()
          .use(route("PURGE", "/cache/all", () => 1))
          .get("/cache/:key", () => 2),
      ),
    ).toEqual(["GET /cache/:key", "HEAD /cache/:key"])

    // Wildcard and part-literal paths are never in the table, and what they outrank is not served
    // from it. `/m/:n/k` is a segment longer than anything above it, so nothing outranks it.
    expect(
      nativeKeys(
        server()
          .get("/x/*rest", () => 1)
          .get("/:a/:b", () => 2)
          .get("/m/:n.json", () => 3)
          .get("/m/:n", () => 4)
          .get("/m/:n/k", () => 5)
          .get("/s/t", () => 6),
      ),
    ).toEqual(["GET /m/:n/k", "GET /s/t", "HEAD /m/:n/k", "HEAD /s/t"])

    // `/a/:x/:y` is outranked from outside the table and `/:p/c/:q` is not. The first stays in the
    // table as the portable dispatcher, so Bun still stops there before it reaches the second.
    expect(
      nativeKeys(
        server()
          .get("/a/b/:n.x", () => 1)
          .get("/a/:x/:y", () => 2)
          .get("/:p/c/:q", () => 3),
      ),
    ).toEqual(["GET /:p/c/:q", "HEAD /:p/c/:q"])

    // A wildcard that the route outranks costs it nothing.
    expect(
      nativeKeys(
        server()
          .get("/files/*path", () => 1)
          .get("/files/:name", () => 2),
      ),
    ).toEqual(["GET /files/:name", "HEAD /files/:name"])
  })

  test("a custom method beside a param route, and a path shielded by a fallback entry", async () => {
    const custom = register(
      register(server(), "PURGE", "/cache/all"),
      "GET",
      "/cache/:key",
    ) as unknown as Served
    const first = await answers(custom, [
      ["GET", "/cache/all"],
      ["GET", "/cache/k1"],
      ["POST", "/cache/k1"],
      ["OPTIONS", "/cache/all"],
    ])
    expect(first.listened).toEqual(first.fetched)
    expect(first.listened[0]).toContain("-> 405 allow=PURGE")

    const shielded = server()
      .get("/a/b/:n.x", (c) => ({ route: "mixed", params: c.params }))
      .get("/a/:x/:y", (c) => ({ route: "middle", params: c.params }))
      .get("/:p/c/:q", (c) => ({ route: "broad", params: c.params }))
    const second = await answers(shielded, [
      ["GET", "/a/b/k.x"],
      ["GET", "/a/b/k"],
      ["GET", "/a/c/k"],
      ["GET", "/z/c/k"],
      ["POST", "/a/c/k"],
    ])
    expect(second.listened).toEqual(second.fetched)
    expect(second.listened[0]).toContain('"route":"mixed"')
    expect(second.listened[1]).toContain('"route":"middle"')
    expect(second.listened[2]).toContain('"route":"middle"')
    expect(second.listened[3]).toContain('"route":"broad"')
    expect(second.listened[4]).toContain("-> 405")
  })

  test("a target with dot segments or a backslash routes the path it resolves to", async () => {
    // Bun matches its table on the target as sent; a `..` it captures as a parameter is a path the
    // portable router resolves first.
    const app = requestTargetApp(server())
    expect(nativeKeys(app)).toContain("GET /users/:id/posts")
    const instance = app.listen(0, { hostname: "127.0.0.1" })
    try {
      expect(await requestTargetMismatches(instance.port)).toEqual([])
    } finally {
      instance.stop(true)
    }
  })

  test("validateHost refuses on Bun every Host that Node and Deno refuse", async () => {
    const app = requestTargetApp(server({ validateHost: true }))
    const instance = app.listen(0, { hostname: "127.0.0.1" })
    try {
      // HTTP/1.0 may leave the Host out: Bun then hands the target over as sent and matched its
      // table on it, so `/users/..` reached `/users/:id` with the id `..`.
      expect(await requestTargetMismatches(instance.port, true)).toEqual([])
      expect(await invalidHostMismatches(instance.port)).toEqual([])
      expect(await refusedHostMismatches(instance.port)).toEqual([])
    } finally {
      instance.stop(true)
    }
  })

  test("without validateHost Bun serves a bad Host, and still refuses one behind a dot segment", async () => {
    const app = requestTargetApp(server())
    expect(nativeKeys(app)).toContain("GET /users/:id")
    const instance = app.listen(0, { hostname: "127.0.0.1" })
    try {
      expect(
        await rawExchange(instance.port, "GET", "/users/7", undefined, ["127.0.0.1", "x.example"]),
      ).toEqual({ status: 200, body: '{"route":"GET /users/:id","id":"7"}' })
      expect(await rawExchange(instance.port, "GET", "/users/../posts", undefined, "a b")).toEqual({
        status: 400,
        body: '{"ok":false,"error":"invalid_host"}',
      })
    } finally {
      instance.stop(true)
    }
  })

  test("a request built in process keeps the URL its caller built, whatever its Host says", async () => {
    const app = requestTargetApp(server())
    const hosts = [...INVALID_HOSTS, ...PARSEABLE_INVALID_HOSTS]
    const answers: unknown[] = []
    for (const host of hosts) {
      const response = await app.fetch(new Request("http://localhost/url", { headers: { host } }))
      answers.push([host, response.status, await response.json()])
    }
    expect(answers).toEqual(hosts.map((host) => [host, 200, { route: "GET /url", path: "/url" }]))
  })

  test("validateHost refuses a Host sent twice or one Node and Deno refuse on Bun's table and in fetch", async () => {
    // Bun builds the URL on such a Host (on the first, joined with ", ", when it repeats).
    const app = requestTargetApp(server({ validateHost: true }))
    expect(nativeKeys(app)).toEqual(expect.arrayContaining(["GET /posts", "GET /users/:id"]))
    const targets = ["/posts", "/users/7", "/url", "/missing"]
    const refusedHosts = [...REPEATED_HOSTS, ...PARSEABLE_INVALID_HOSTS]
    const instance = app.listen(0, { hostname: "127.0.0.1" })
    try {
      const answers: unknown[] = []
      for (const hosts of refusedHosts) {
        for (const target of targets) {
          answers.push([
            hosts,
            target,
            await rawExchange(instance.port, "GET", target, undefined, hosts),
          ])
        }
      }
      const refused = { status: 400, body: '{"ok":false,"error":"invalid_host"}' }
      expect(answers).toEqual(
        refusedHosts.flatMap((hosts) => targets.map((target) => [hosts, target, refused])),
      )
      expect(await rawExchange(instance.port, "GET", "/users/7")).toEqual({
        status: 200,
        body: '{"route":"GET /users/:id","id":"7"}',
      })
      expect(await rawExchange(instance.port, "GET", "/posts", undefined, "LOCALHOST:80")).toEqual({
        status: 200,
        body: '{"route":"GET /posts"}',
      })
    } finally {
      instance.stop(true)
    }
  })

  test("validateHost refuses an empty Host on the first request a process serves", async () => {
    // The last-valid-Host cache is process-wide, so only a fresh process shows its starting value.
    const script = `
      import { server, silentLogger } from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)}
      import { rawExchange } from ${JSON.stringify(new URL("./request-target-matrix.ts", import.meta.url).href)}
      const app = server({ validateHost: true, logger: silentLogger }).get("/users/:id", (c) => ({ id: c.params.id }))
      const instance = app.listen(0, { hostname: "127.0.0.1" })
      const answer = await rawExchange(instance.port, "GET", "/users/7", undefined, "")
      instance.stop(true)
      process.stdout.write(String(answer.status))
    `
    const child = Bun.spawn([process.execPath, "--eval", script], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    expect([out.slice(-3), code]).toEqual(["400", 0])
  })

  test("a request built in process is refused only on the URL Bun would build on its Host", async () => {
    const app = requestTargetApp(server({ validateHost: true }))
    const twoHosts = (url: string) =>
      app.fetch(
        new Request(url, {
          headers: [
            ["host", "a.example"],
            ["host", "b.example"],
          ],
        }),
      )
    const kept = await twoHosts("http://localhost/url")
    expect([kept.status, await kept.json()]).toEqual([200, { route: "GET /url", path: "/url" }])
    expect((await twoHosts("http://A.example:80/url")).status).toBe(400)
    const encoded = new Request("http://a.example/url", { headers: { host: "%61.example" } })
    expect((await app.fetch(encoded)).status).toBe(400)
  })

  test("generated route tables answer every probe the same on both lanes", async () => {
    // Deterministic generator, so a failure names a table that can be replayed.
    let state = 0x2f6e2b1
    const random = (bound: number): number => {
      state = (state + 0x6d2b79f5) | 0
      let t = Math.imul(state ^ (state >>> 15), 1 | state)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return (((t ^ (t >>> 14)) >>> 0) % bound) | 0
    }
    const inner = ["a", "b", ":p", ":q", ":n.x", "a-:k", ":d{[0-9]+}", ":l{a|c}"]
    const last = [...inner, "*w"]
    const methods = ["GET", "POST", "HEAD", "PURGE"]

    const words = ["a", "b", "c", "c.x", "a-1", "7"]
    const paths: string[] = []
    for (const one of words) {
      paths.push(`/${one}`)
      for (const two of words) {
        paths.push(`/${one}/${two}`)
        for (const three of words) paths.push(`/${one}/${two}/${three}`)
      }
    }
    const requests = paths.flatMap((path) => methods.map((method) => [method, path] as const))

    for (let round = 0; round < 40; round++) {
      let app: BareServer = server()
      const table: string[] = []
      for (let i = 0; i < 7; i++) {
        const depth = 1 + random(3)
        const segments: string[] = []
        for (let d = 0; d < depth; d++) {
          const pool = d === depth - 1 ? last : inner
          segments.push(pool[random(pool.length)]!)
        }
        const path = `/${segments.join("/")}`
        const method = methods[random(methods.length)]!
        try {
          app = register(app, method, path)
          table.push(`${method} ${path}`)
        } catch {
          // A duplicate route, or a repeated parameter name: not part of this table.
        }
      }
      const { listened, fetched } = await answers(app, requests)
      for (let i = 0; i < listened.length; i++) {
        if (listened[i] !== fetched[i]) {
          throw new Error(
            `table [${table.join(", ")}]\n  listen: ${listened[i]}\n  fetch:  ${fetched[i]}`,
          )
        }
      }
      expect(listened.length).toBe(requests.length)
    }
  }, 30_000)
})
