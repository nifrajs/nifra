import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { server } from "../src/index.ts"
import { parseCookies, serializeCookie } from "../src/server/cookies.ts"
import { queryObjectOf } from "../src/server/query.ts"
import { sse } from "../src/server/sse.ts"

/**
 * Hostile requests from attack classes that have broken web frameworks: a path spelled so a guard
 * and the router disagree about it, a header or cookie value that writes a second one, a key that
 * reaches a prototype, a content type that slips past body validation. Each test sends the attack
 * and pins the answer that keeps it out.
 */

// Spellings of `/admin/panel` an attacker tries, so a guard reading the path misses the request the
// router still sends to the route: case, percent-encoding, doubled or trailing slashes, dot
// segments raw and encoded, backslashes, matrix parameters, NUL and trailing dots.
const SPELLINGS = [
  "/admin/panel",
  "/ADMIN/panel",
  "/%61dmin/panel",
  "/admin%2Fpanel",
  "/admin%2fpanel",
  "//admin/panel",
  "/./admin/panel",
  "/x/../admin/panel",
  "/x/%2e%2e/admin/panel",
  "/x/%2E%2E/admin/panel",
  "/x/..%2fadmin/panel",
  "/x/%2e%2e%2fadmin/panel",
  "/admin/panel/",
  "/admin//panel",
  "/admin/panel;x",
  "/admin/panel%00",
  "/admin/panel.",
  "/admin/./panel",
  "/admin\\panel",
  "/\\admin\\panel",
  "/admin/panel%20",
  "/admin/pane%6c",
  "/admin/panel%3F",
  "/admin/panel%23",
]

const bodyAt = async (
  app: { fetch(request: Request): Response | Promise<Response> },
  path: string,
): Promise<string> => (await app.fetch(new Request(`http://x${path}`))).text()

describe("path canonicalization", () => {
  test("a guard that reads the request path sees every spelling the router serves the route", async () => {
    const app = server()
      .onRequest((request) =>
        new URL(request.url).pathname.startsWith("/admin/")
          ? new Response("guarded", { status: 401 })
          : undefined,
      )
      .get("/admin/panel", () => "secret")
    for (const path of SPELLINGS)
      expect([path, await bodyAt(app, path)]).not.toEqual([path, '"secret"'])
  })

  test("a route answers only the spellings a URL parser resolves to its own path", async () => {
    const app = server().get("/admin/panel", () => "secret")
    const served: string[] = []
    for (const path of SPELLINGS) if ((await bodyAt(app, path)) === '"secret"') served.push(path)
    expect(served).toEqual([
      "/admin/panel",
      "/./admin/panel",
      "/x/../admin/panel",
      "/x/%2e%2e/admin/panel",
      "/x/%2E%2E/admin/panel",
      "/admin/./panel",
      "/admin\\panel",
    ])
  })

  test("a mount serves its prefix and the paths below it, not a path that only starts with it", async () => {
    const app = server()
      .mountFetch("/api/*", (request) => new Response(`mount ${new URL(request.url).pathname}`))
      .get("/apix", () => "apix")
      .get("/admin", () => "admin")
    const answers: Record<string, string> = {}
    for (const path of ["/api/x", "/apix", "/api%2Fx", "/API/x", "//api/x", "/api/../admin"])
      answers[path] = await bodyAt(app, path)
    expect(answers).toEqual({
      "/api/x": "mount /api/x",
      "/apix": '"apix"',
      "/api%2Fx": '{"ok":false,"error":"not_found"}',
      "/API/x": '{"ok":false,"error":"not_found"}',
      "//api/x": '{"ok":false,"error":"not_found"}',
      "/api/../admin": '"admin"',
    })
  })

  test("a wildcard parameter is decoded, so a `../` in it reaches the handler as text", async () => {
    // A handler that joins this into a filesystem path must confine it; the public-dir handler does.
    const app = server().get("/files/*rest", (c) => ({ rest: c.params.rest }))
    expect(await bodyAt(app, "/files/..%2f..%2fetc%2fpasswd")).toBe('{"rest":"../../etc/passwd"}')
    expect(await bodyAt(app, "/files/%2e%2e/%2e%2e/etc")).toBe('{"ok":false,"error":"not_found"}')
  })
})

describe("cookies", () => {
  test("a cookie value cannot write a second cookie or an attribute", () => {
    expect(serializeCookie("a", "v\r\nSet-Cookie: x=1")).toBe("a=v%0D%0ASet-Cookie%3A%20x%3D1")
    expect(serializeCookie("a", "v; Domain=evil.example")).toBe("a=v%3B%20Domain%3Devil.example")
  })

  test("a cookie name or attribute holding a separator is refused", () => {
    expect(() => serializeCookie("a;b", "v")).toThrow("invalid cookie name")
    expect(() => serializeCookie(" a", "v")).toThrow("invalid cookie name")
    expect(() => serializeCookie("a", "v", { path: "/; Domain=evil.example" })).toThrow(
      "illegal character",
    )
    expect(() => serializeCookie("a", "v", { domain: "x.example; Secure" })).toThrow(
      "illegal character",
    )
  })

  test("a cookie name with a leading no-break space stays its own cookie", () => {
    const jar = parseCookies(" session=evil; session=good")
    expect(jar.session).toBe("good")
    expect(jar[" session"]).toBe("evil")
  })

  test("a cookie named after a prototype key is an ordinary entry", () => {
    const jar = parseCookies("__proto__=x; constructor=y; toString=z")
    expect(Object.getPrototypeOf(jar)).toBeNull()
    expect(Object.entries(jar)).toEqual([
      ["__proto__", "x"],
      ["constructor", "y"],
      ["toString", "z"],
    ])
    expect(Reflect.get({}, "x")).toBeUndefined()
  })
})

describe("query strings", () => {
  test("bracket and dot keys stay flat strings, so none of them reaches a prototype", () => {
    const query = queryObjectOf(
      "__proto__[x]=1&a[__proto__][y]=2&constructor[prototype][z]=3&a.b.c=4&__proto__=5",
    )
    expect(Object.entries(query)).toEqual([
      ["__proto__[x]", "1"],
      ["a[__proto__][y]", "2"],
      ["constructor[prototype][z]", "3"],
      ["a.b.c", "4"],
      ["__proto__", "5"],
    ])
    for (const key of ["x", "y", "z"]) expect(Reflect.get({}, key)).toBeUndefined()
  })
})

describe("server-sent events", () => {
  test("a line break in any field cannot start another field or event", async () => {
    const app = server().get("/events", (c) =>
      sse(c, (stream) => {
        stream.send({
          comment: "c\ndata: forged",
          event: "a\nevent: forged",
          id: "1\nretry: 1",
          data: "x\r\ndata: forged\rid: 9",
        })
        stream.close()
      }),
    )
    expect(await bodyAt(app, "/events")).toBe(
      ": cdata: forged\nevent: aevent: forged\nid: 1retry: 1\ndata: x\ndata: data: forged\ndata: id: 9\n\n",
    )
  })
})

describe("request bodies", () => {
  test("a JSON body containing __proto__ is refused before the handler", async () => {
    const app = server().post("/items", { body: t.looseObject({ name: t.string() }) }, (c) => ({
      admin: Reflect.get(c.body, "admin") ?? false,
    }))
    const res = await app.fetch(
      new Request("http://x/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"name":"n","__proto__":{"admin":true}}',
      }),
    )
    expect(res.status).toBe(400)
  })

  test("no spelling of the content type lets a body past its schema", async () => {
    const app = server().post("/items", { body: t.object({ n: t.integer() }) }, (c) => c.body)
    const statuses: Record<string, number> = {}
    for (const type of [
      "application/json",
      " application/json",
      "\tapplication/json",
      "application/json ",
      "Application/JSON",
      "application/json;",
      "application/json\t;x",
      "application/vnd.api+json",
      "application/jsonx",
      "application/x-www-form-urlencoded",
      "text/plain",
      "",
    ]) {
      const res = await app.fetch(
        new Request("http://x/items", {
          method: "POST",
          headers: type === "" ? {} : { "content-type": type },
          body: '{"n":"not a number"}',
        }),
      )
      statuses[JSON.stringify(type)] = res.status
    }
    for (const status of Object.values(statuses)) expect([415, 422]).toContain(status)
  })
})
