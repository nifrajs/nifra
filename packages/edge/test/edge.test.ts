import { expect, test } from "bun:test"
import { bodyParser } from "@nifrajs/core/body-parser"
import { multipartBody } from "@nifrajs/core/multipart"
import { notFound as coreNotFound, type NotFoundHandler } from "@nifrajs/core/not-found"
import { server as coreServer } from "@nifrajs/core/server"
import { notFound, type StandardSchemaV1, server, toFetchHandler } from "../src/index.ts"

/** A hand-rolled Standard Schema for `{ name: string; age: number }` - no schema library in the test. */
const userBody: StandardSchemaV1<{ name: string; age: number }> = {
  "~standard": {
    version: 1,
    vendor: "edge-test",
    validate(value) {
      const v = value as { name?: unknown; age?: unknown }
      return typeof v?.name === "string" && typeof v?.age === "number"
        ? { value: { name: v.name, age: v.age } }
        : { issues: [{ message: "expected { name: string; age: number }" }] }
    },
  },
}

/** Both servers, wired to the SAME routes, so a rejection can be compared byte for byte. */
function edgeApp() {
  return server()
    .get("/users/:id", (c) => ({ id: c.params.id }))
    .post("/users", { body: userBody }, (c) => ({ created: c.body.name, age: c.body.age }))
}
function coreApp() {
  return coreServer()
    .get("/users/:id", (c) => ({ id: c.params.id }))
    .post("/users", { body: userBody }, (c) => ({ created: c.body.name, age: c.body.age }))
}

const jsonReq = (path: string, method: string, body: unknown, headers?: Record<string, string>) =>
  new Request(`https://x.test${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })

/** Status + body + the headers that carry meaning for these envelopes. */
async function wire(res: Response) {
  return {
    status: res.status,
    body: await res.clone().text(),
    allow: res.headers.get("allow"),
  }
}

test("GET resolves typed path params, rendered as JSON", async () => {
  const res = await edgeApp().fetch(new Request("https://x.test/users/42"))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ id: "42" })
})

test("POST validates the body and narrows c.body", async () => {
  const res = await edgeApp().fetch(jsonReq("/users", "POST", { name: "ada", age: 36 }))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ created: "ada", age: 36 })
})

test("query() parses the search string on demand", async () => {
  const app = server().get("/s", (c) => c.query())
  const res = await app.fetch(new Request("https://x.test/s?q=hi&tag=a&tag=b"))
  expect(await res.json()).toEqual({ q: "hi", tag: ["a", "b"] })
})

test("header() reads request headers case-insensitively", async () => {
  const app = server().get("/h", (c) => ({ ua: c.header("User-Agent") }))
  const res = await app.fetch(new Request("https://x.test/h", { headers: { "user-agent": "z" } }))
  expect(await res.json()).toEqual({ ua: "z" })
})

test("all body-bearing verbs carry the schema lane", async () => {
  for (const method of ["PUT", "PATCH", "DELETE"] as const) {
    const app = server()[method.toLowerCase() as "put"]("/r", { body: userBody }, (c) => c.body)
    const ok = await app.fetch(jsonReq("/r", method, { name: "x", age: 1 }))
    expect(ok.status).toBe(200)
    const bad = await app.fetch(jsonReq("/r", method, { name: "x" }))
    expect(bad.status).toBe(422)
  }
})

test("HEAD and OPTIONS register as body-less routes", async () => {
  const app = server()
    .head("/x", () => "")
    .options("/x", () => ({ ok: true }))
  expect((await app.fetch(new Request("https://x.test/x", { method: "OPTIONS" }))).status).toBe(200)
})

test("a handler may throw a Response for an early exit", async () => {
  const app = server().get("/e", () => {
    throw new Response("gone", { status: 410 })
  })
  const res = await app.fetch(new Request("https://x.test/e"))
  expect(res.status).toBe(410)
  expect(await res.text()).toBe("gone")
})

test("a non-Response throw becomes a flat 500 (no leak)", async () => {
  const app = server().get("/boom", () => {
    throw new Error("secret internal detail")
  })
  const res = await app.fetch(new Request("https://x.test/boom"))
  expect(res.status).toBe(500)
  expect(await res.text()).not.toContain("secret internal detail")
})

test("custom maxBodyBytes rejects an over-cap body with 413", async () => {
  const app = server({ maxBodyBytes: 16 }).post("/u", { body: userBody }, (c) => c.body)
  const res = await app.fetch(jsonReq("/u", "POST", { name: "a".repeat(1000), age: 1 }))
  expect(res.status).toBe(413)
})

// --- Byte-parity with the full @nifrajs/core server: the whole point of reusing the shipped lane. ---

test("parity: 404 not-found envelope matches the full Server", async () => {
  const req = () => new Request("https://x.test/nope")
  expect(await wire(await edgeApp().fetch(req()))).toEqual(await wire(await coreApp().fetch(req())))
})

test("parity: 405 method-not-allowed + Allow header matches", async () => {
  const req = () => new Request("https://x.test/users/1", { method: "DELETE" })
  const e = await wire(await edgeApp().fetch(req()))
  expect(e).toEqual(await wire(await coreApp().fetch(req())))
  expect(e.status).toBe(405)
  expect(e.allow).toContain("GET")
})

test("parity: 422 validation envelope (with issues) matches", async () => {
  const req = () => jsonReq("/users", "POST", { name: "ada" })
  const e = await wire(await edgeApp().fetch(req()))
  expect(e).toEqual(await wire(await coreApp().fetch(req())))
  expect(e.status).toBe(422)
})

test("parity: 415 unsupported-media-type matches", async () => {
  const req = () =>
    new Request("https://x.test/users", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    })
  const e = await wire(await edgeApp().fetch(req()))
  expect(e).toEqual(await wire(await coreApp().fetch(req())))
  expect(e.status).toBe(415)
})

test("parity: 400 malformed-JSON matches", async () => {
  const req = () =>
    new Request("https://x.test/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    })
  const e = await wire(await edgeApp().fetch(req()))
  expect(e).toEqual(await wire(await coreApp().fetch(req())))
  expect(e.status).toBe(400)
})

test("parity: prototype-poisoning is rejected identically (default reject policy)", async () => {
  const req = () =>
    jsonReq("/users", "POST", JSON.parse('{"name":"a","age":1,"__proto__":{"x":1}}'))
  const e = await wire(await edgeApp().fetch(req()))
  expect(e).toEqual(await wire(await coreApp().fetch(req())))
})

test("parity: an urlencoded form body is framed the same way", async () => {
  const req = () =>
    new Request("https://x.test/users", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "name=ada&age=36",
    })
  // Same status on both (the form reaches the schema, which rejects age as a string -> 422).
  const e = await edgeApp().fetch(req())
  const c = await coreApp().fetch(req())
  expect(e.status).toBe(c.status)
})

/** A hand-rolled Standard Schema for an upload form: a text `title` and one `doc` file. */
const uploadBody: StandardSchemaV1<{ title: string; doc: File }> = {
  "~standard": {
    version: 1,
    vendor: "edge-test",
    validate(value) {
      const v = value as { title?: unknown; doc?: unknown }
      return typeof v?.title === "string" && v.doc instanceof File
        ? { value: { title: v.title, doc: v.doc } }
        : { issues: [{ message: "expected { title: string; doc: File }" }] }
    },
  },
}
const describeUpload = (c: { body: { title: string; doc: File } }) => ({
  title: c.body.title,
  name: c.body.doc.name,
  size: c.body.doc.size,
})
const edgeUploads = () =>
  server()
    .post("/docs", { body: multipartBody(uploadBody, { maxFiles: 1 }) }, describeUpload)
    .post("/plain", { body: uploadBody }, describeUpload)
const coreUploads = () =>
  coreServer()
    .post("/docs", { body: multipartBody(uploadBody, { maxFiles: 1 }) }, describeUpload)
    .post("/plain", { body: uploadBody }, describeUpload)

const formReq = (path: string, parts: ReadonlyArray<readonly [string, string | File]>) => {
  const form = new FormData()
  for (const [name, value] of parts) form.append(name, value)
  return new Request(`https://x.test${path}`, { method: "POST", body: form })
}

test("a multipart body reaches the handler as fields and files", async () => {
  const res = await edgeUploads().fetch(
    formReq("/docs", [
      ["title", "report"],
      ["doc", new File(["hello"], "../../etc/report.txt")],
    ]),
  )
  expect(res.status).toBe(200)
  // The file name is reduced to its last segment before the handler sees it.
  expect(await res.json()).toEqual({ title: "report", name: "report.txt", size: 5 })
})

test("parity: multipart rejections match the full Server", async () => {
  const doc = () => new File(["hello"], "a.txt")
  const cases: ReadonlyArray<() => Request> = [
    // A route that did not opt in refuses the content type.
    () =>
      formReq("/plain", [
        ["title", "t"],
        ["doc", doc()],
      ]),
    // More files than the route allows.
    () =>
      formReq("/docs", [
        ["title", "t"],
        ["doc", doc()],
        ["doc", doc()],
      ]),
    // The schema rejects a form with no file.
    () => formReq("/docs", [["title", "t"]]),
    // A body that is not the multipart it claims to be.
    () =>
      new Request("https://x.test/docs", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=x" },
        body: "not a form",
      }),
    // No boundary parameter at all.
    () =>
      new Request("https://x.test/docs", {
        method: "POST",
        headers: { "content-type": "multipart/form-data" },
        body: "--x--",
      }),
  ]
  const statuses: number[] = []
  for (const req of cases) {
    const e = await wire(await edgeUploads().fetch(req()))
    expect(e).toEqual(await wire(await coreUploads().fetch(req())))
    statuses.push(e.status)
  }
  expect(statuses).toEqual([415, 413, 422, 400, 400])
})

test("a multipart body over maxBodyBytes is rejected with 413", async () => {
  const app = server({ maxBodyBytes: 64 }).post(
    "/docs",
    { body: multipartBody(uploadBody) },
    describeUpload,
  )
  const res = await app.fetch(
    formReq("/docs", [
      ["title", "t"],
      ["doc", new File(["x".repeat(500)], "big.txt")],
    ]),
  )
  expect(res.status).toBe(413)
})

const linesBody = () =>
  bodyParser(userBody, {
    types: ["application/yaml"],
    parse: (bytes) => {
      const out: Record<string, unknown> = {}
      for (const line of new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\n")) {
        if (line === "") continue
        const at = line.indexOf(": ")
        if (at === -1) throw new Error("not a line")
        const value = line.slice(at + 2)
        out[line.slice(0, at)] = /^\d+$/.test(value) ? Number(value) : value
      }
      return out
    },
  })
const describeUser = (c: { body: { name: string; age: number } }) => ({
  created: c.body.name,
  age: c.body.age,
})

test("parity: a body in a media type the route names matches the full Server", async () => {
  const options = { maxBodyBytes: 64 }
  const edge = () => server(options).post("/users", { body: linesBody() }, describeUser)
  const core = () => coreServer(options).post("/users", { body: linesBody() }, describeUser)
  const yaml = (body: string, contentType = "application/yaml") =>
    new Request("https://x.test/users", {
      method: "POST",
      headers: { "content-type": contentType },
      body: new TextEncoder().encode(body),
    })
  const cases: ReadonlyArray<() => Request> = [
    () => yaml("name: Ada\nage: 36\n"),
    () => yaml("name: Ada\nage: 36\n", "Application/YAML; charset=utf-8"),
    // A media type the route did not name.
    () => yaml("name: Ada\nage: 36\n", "text/yaml"),
    // Over the byte cap.
    () => yaml(`name: ${"x".repeat(200)}\nage: 36\n`),
    // The parser refuses the body.
    () => yaml("no separator"),
    // The schema refuses what the parser decoded.
    () => yaml("name: Ada\n"),
    // JSON keeps its own lane.
    () => yaml('{"name":"Ada","age":36}', "application/json"),
  ]
  const statuses: number[] = []
  for (const req of cases) {
    const e = await wire(await edge().fetch(req()))
    expect(e).toEqual(await wire(await core().fetch(req())))
    statuses.push(e.status)
  }
  expect(statuses).toEqual([200, 200, 415, 413, 400, 422, 200])
})

// One handler, driven by the path, so every rule is compared on both servers.
const missHandler: NotFoundHandler = ({ method, pathname, url, header }) => {
  switch (pathname) {
    case "/default":
      return undefined
    case "/created":
      return new Response("made", { status: 201, headers: { "x-miss": "1" } })
    case "/empty":
      return new Response(null, { status: 204 })
    case "/moved":
      return new Response(null, { status: 308, headers: { location: "/new" } })
    case "/gone":
      return new Response("gone", { status: 410 })
    case "/thrown":
      throw Response.json({ thrown: true })
    case "/boom":
      throw new Error("secret detail")
    case "/rejects":
      return Promise.reject(new Error("secret detail"))
    case "/text":
      return "secret detail" as unknown as Response
    case "/unusable":
      return Response.error()
    default:
      return Response.json({ method, pathname, url, accept: header("accept") })
  }
}

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const edgeMisses = () => server({ notFound: notFound(missHandler) }).post("/users", () => "ok")
const coreMisses = () =>
  coreServer({ logger: silent })
    .use(coreNotFound(missHandler))
    .post("/users", () => "ok")

/** A transport can deliver a method token no `Request` constructor would build. */
function requestWith(method: string, url: string): Request {
  const request = new Request(url)
  Object.defineProperty(request, "method", { value: method })
  return request
}

test("parity: a not-found handler answers the same as on the full Server", async () => {
  const at = (path: string, init?: RequestInit) => () => new Request(`https://x.test${path}`, init)
  const cases: ReadonlyArray<readonly [() => Request, number]> = [
    [at("/a%2Fb?x=1", { headers: { accept: "text/html" } }), 404],
    [at("/default"), 404],
    [at("/created"), 404],
    [at("/empty"), 404],
    [at("/moved"), 308],
    [at("/gone"), 410],
    [at("/thrown"), 404],
    [at("/boom"), 500],
    [at("/rejects"), 500],
    [at("/text"), 500],
    [at("/unusable"), 500],
    // A path that exists under another method is not a miss.
    [at("/users"), 405],
    // A method token no route could be registered under never reaches the handler.
    [() => requestWith("get", "https://x.test/anything"), 404],
  ]
  for (const [req, status] of cases) {
    const edge = await edgeMisses().fetch(req())
    const core = await coreMisses().fetch(req())
    const e = await wire(edge)
    expect(e).toEqual(await wire(core))
    expect(e.status).toBe(status)
    expect(e.body).not.toContain("secret")
    for (const name of ["content-type", "location", "x-miss"]) {
      expect(edge.headers.get(name)).toBe(core.headers.get(name))
    }
  }
  const echoed = await (await edgeMisses().fetch(at("/a%2Fb?x=1")())).json()
  expect(echoed).toEqual({
    method: "GET",
    pathname: "/a%2Fb",
    url: "https://x.test/a%2Fb?x=1",
    accept: null,
  })
  expect(
    await (await edgeMisses().fetch(requestWith("get", "https://x.test/anything"))).json(),
  ).toEqual({ ok: false, error: "not_found" })
})

test("notFound() needs a handler function", () => {
  expect(() => notFound(undefined as unknown as NotFoundHandler)).toThrow(
    "notFound() needs a handler function",
  )
})

test("toFetchHandler yields a Workers { fetch } module handler", async () => {
  const handler = toFetchHandler(edgeApp())
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as Parameters<
    typeof handler.fetch
  >[2]
  const res = await handler.fetch(new Request("https://x.test/users/7"), {}, ctx)
  expect(await res.json()).toEqual({ id: "7" })
})

test("path params are decoded as core decodes them, and a malformed escape is a 400", async () => {
  const edgeFiles = server()
    .get("/files/:name", (c) => ({ name: c.params.name }))
    .get("/w/*", (c) => ({ rest: c.params["*"] }))
  const coreFiles = coreServer()
    .get("/files/:name", (c) => ({ name: c.params.name }))
    .get("/w/*", (c) => ({ rest: c.params["*"] }))
  for (const path of ["/files/a%20b", "/w/a%2Fb", "/files/%E0%A4"]) {
    const [onEdge, onCore] = await Promise.all([
      edgeFiles.fetch(new Request(`http://x${path}`)),
      coreFiles.fetch(new Request(`http://x${path}`)),
    ])
    expect(onEdge.status).toBe(onCore.status)
    expect(await onEdge.text()).toBe(await onCore.text())
  }
  const decoded = await edgeFiles.fetch(new Request("http://x/files/a%20b"))
  expect(await decoded.json()).toEqual({ name: "a b" })
  expect((await edgeFiles.fetch(new Request("http://x/files/%E0%A4"))).status).toBe(400)
})

test("a path ending in optional params serves each shorter path too", async () => {
  const edge = server().get("/reports/:year?/:month?", (c) => ({
    year: c.params.year ?? null,
    month: c.params.month ?? null,
  }))
  const core = coreServer().get("/reports/:year?/:month?", (c) => ({
    year: c.params.year ?? null,
    month: c.params.month ?? null,
  }))
  for (const path of ["/reports", "/reports/2026", "/reports/2026/09", "/reports/2026/09/x"]) {
    const request = () => new Request(`https://x.test${path}`)
    expect(await wire(await edge.fetch(request()))).toEqual(await wire(await core.fetch(request())))
  }
  expect(await (await edge.fetch(new Request("https://x.test/reports"))).json()).toEqual({
    year: null,
    month: null,
  })
  expect(await (await edge.fetch(new Request("https://x.test/reports/2026"))).json()).toEqual({
    year: "2026",
    month: null,
  })
})

test("a param constraint picks the route, byte for byte as the full server does", async () => {
  const edge = server()
    .get("/users/:name", () => ({ route: "name" }))
    .get("/users/:id{[0-9]+}", () => ({ route: "numeric" }))
    .get("/img/:kind{thumb|full}", () => ({ route: "kind" }))
    .get("/f/:name.:ext{png|jpg}", () => ({ route: "file" }))
    .get("/o/:page{[0-9]+}?", () => ({ route: "page" }))
  const core = coreServer()
    .get("/users/:name", () => ({ route: "name" }))
    .get("/users/:id{[0-9]+}", () => ({ route: "numeric" }))
    .get("/img/:kind{thumb|full}", () => ({ route: "kind" }))
    .get("/f/:name.:ext{png|jpg}", () => ({ route: "file" }))
    .get("/o/:page{[0-9]+}?", () => ({ route: "page" }))
  for (const path of [
    "/users/42",
    "/users/ada",
    "/users/4%32",
    "/img/thumb",
    "/img/other",
    "/f/a.png",
    "/f/a.b.png",
    "/o",
    "/o/3",
    "/o/x",
  ]) {
    const request = () => new Request(`https://x.test${path}`)
    expect(await wire(await edge.fetch(request()))).toEqual(await wire(await core.fetch(request())))
  }
  expect(await (await edge.fetch(new Request("https://x.test/users/42"))).json()).toEqual({
    route: "numeric",
  })
  expect(await (await edge.fetch(new Request("https://x.test/users/4%32"))).json()).toEqual({
    route: "name",
  })
  expect((await edge.fetch(new Request("https://x.test/img/other"))).status).toBe(404)
  const miss = await edge.fetch(new Request("https://x.test/users/42", { method: "POST" }))
  expect(miss.status).toBe(405)
  expect(miss.headers.get("allow")).toBe("GET, HEAD")
})

test("a constrained param is typed by its bare name", async () => {
  const edge = server().get("/users/:id{[0-9]+}", (c) => {
    const id: string = c.params.id
    return { id }
  })
  expect(await (await edge.fetch(new Request("https://x.test/users/7"))).json()).toEqual({
    id: "7",
  })
})
