import { describe, expect, test } from "bun:test"
import { server } from "../src/index.ts"
import { method as route } from "../src/server/methods.ts"

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
  const table =
    (app as { buildBunNativeRoutes(fallback: NativeHandler): NativeTable }).buildBunNativeRoutes(
      portable,
    ) ?? {}
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
  requests: readonly (readonly [method: string, path: string])[],
): Promise<{ listened: string[]; fetched: string[] }> {
  // A HEAD answer has no body on the wire, so the two lanes are compared on what both can show.
  const show = async (label: string, response: Response): Promise<string> =>
    `${label} -> ${response.status} allow=${response.headers.get("allow")} ${
      label.startsWith("HEAD") ? "" : await response.text()
    }`
  // Bound to the loopback address itself: a port picked for every interface can be one another
  // process already holds on loopback, and that process would get these requests.
  const instance = app.listen(0, { hostname: "127.0.0.1" })
  const listened: string[] = []
  const fetched: string[] = []
  try {
    for (const [method, path] of requests) {
      const label = `${method} ${path}`
      listened.push(
        await show(label, await fetch(`http://127.0.0.1:${instance.port}${path}`, { method })),
      )
      fetched.push(await show(label, await app.fetch(new Request(`http://x${path}`, { method }))))
    }
  } finally {
    instance.stop(true)
  }
  return { listened, fetched }
}

describe("Bun-native route table agrees with the portable router", () => {
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
