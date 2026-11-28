/**
 * `staticResponse()` routes are compiled into uWS and answered without entering JS. Wherever that path
 * applies it must answer exactly as `@nifrajs/node` does; wherever something in the app could observe
 * the request, the route must stay on the ordinary path.
 */
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { echoParam, server, staticResponse } from "@nifrajs/core"
import { websocket } from "@nifrajs/core/ws"
import { serve as serveNode } from "@nifrajs/node"
import { serve as serveEngine } from "../src/index.ts"
import { parseHead, raw } from "./support.ts"

const SKIP = new Set(["date", "connection", "keep-alive"])

function makeApp() {
  return server()
    .get("/ping", staticResponse({ headers: { "cache-control": "no-store", "x-fixed": "1" } }))
    .post("/ping", staticResponse())
    .get("/created", staticResponse({ status: 201 }))
    .get("/nothing", staticResponse({ status: 204 }))
    .get("/api/v1/health", staticResponse())
    .get("/user/:id", echoParam("/user/:id"))
    .get("/dynamic", () => new Response("dynamic"))
}

let stops: Array<() => Promise<void>> = []
let nodePort = 0
let enginePort = 0

before(async () => {
  const nodeServer = await serveNode(makeApp(), { port: 0 })
  const engineServer = await serveEngine(makeApp(), { port: 0, maxBodySize: 4_000_000 })
  nodePort = nodeServer.port
  enginePort = engineServer.port
  stops = [() => nodeServer.stop(), () => engineServer.stop()]
})

after(async () => {
  for (const stop of stops) await stop()
})

async function observe(port: number, request: string | Buffer) {
  const text = await raw(port, request, (received) => {
    const parsed = parseHead(received)
    if (!received.includes("\r\n\r\n")) return false
    if (parsed.headers.get("transfer-encoding")?.[0] === "chunked")
      return received.endsWith("0\r\n\r\n")
    const length = Number(parsed.headers.get("content-length")?.[0] ?? 0)
    return parsed.body.length >= length
  })
  const parsed = parseHead(text)
  let body = parsed.body
  const chunked = parsed.headers.get("transfer-encoding")?.[0] === "chunked"
  if (chunked) {
    // uWS fills a path parameter into a reply whose length it cannot know, so it frames it chunked; the
    // same bytes as a counted body once decoded.
    let rest = body
    body = ""
    for (;;) {
      const eol = rest.indexOf("\r\n")
      const size = Number.parseInt(rest.slice(0, eol), 16)
      if (size === 0) break
      body += rest.slice(eol + 2, eol + 2 + size)
      rest = rest.slice(eol + 2 + size + 2)
    }
  }
  const headers: Array<[string, string]> = []
  for (const [name, values] of parsed.headers) {
    if (SKIP.has(name) || (chunked && name === "transfer-encoding")) continue
    for (const value of values) headers.push([name, value])
  }
  if (chunked) headers.push(["content-length", String(body.length)])
  headers.sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]))
  return { status: parsed.status, headers, body }
}

const head = (method: string, path: string, extra = ""): string =>
  `${method} ${path} HTTP/1.1\r\nHost: example.test\r\n${extra}\r\n`

const cases: Array<[string, string | Buffer]> = [
  ["GET with fixed headers", head("GET", "/ping")],
  ["GET with a query", head("GET", "/ping?a=1&b=%20")],
  ["POST with a body", Buffer.from(`${head("POST", "/ping", "content-length: 3\r\n")}abc`)],
  [
    "POST with a body over the 1 MB cap",
    Buffer.concat([
      Buffer.from(head("POST", "/ping", "content-length: 1200000\r\n")),
      Buffer.alloc(1_200_000, 7),
    ]),
  ],
  ["POST without a body", head("POST", "/ping", "content-length: 0\r\n")],
  [
    "POST with a chunked body",
    `POST /ping HTTP/1.1\r\nHost: example.test\r\ntransfer-encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n`,
  ],
  [
    "a cross-site form POST is refused as on every other route",
    head(
      "POST",
      "/ping",
      "origin: https://evil.test\r\ncontent-type: text/plain\r\ncontent-length: 0\r\n",
    ),
  ],
  [
    "Fetch Metadata refuses a cross-site POST when Origin is missing",
    head("POST", "/ping", "sec-fetch-site: cross-site\r\ncontent-length: 0\r\n"),
  ],
  ["201 status", head("GET", "/created")],
  ["204 stays bodyless", head("GET", "/nothing")],
  ["nested path", head("GET", "/api/v1/health")],
  ["trailing slash", head("GET", "/ping/")],
  ["other case", head("GET", "/PING")],
  ["percent-encoded path", head("GET", "/%70ing")],
  ["method with no route", head("PUT", "/ping")],
  ["echoParam with a plain id", head("GET", "/user/abc")],
  ["echoParam with a query", head("GET", "/user/abc?x=1&y=%20")],
  ["echoParam with percent-escapes", head("GET", "/user/%41bc")],
  ["echoParam with an escaped slash", head("GET", "/user/a%2Fb")],
  ["echoParam with UTF-8 escapes", head("GET", "/user/caf%C3%A9")],
  ["echoParam with an empty segment", head("GET", "/user/")],
  ["echoParam with a deeper path", head("GET", "/user/a/b")],
  ["echoParam on POST", head("POST", "/user/abc", "content-length: 0\r\n")],
  ["dynamic route beside them", head("GET", "/dynamic")],
  ["unknown route", head("GET", "/nope")],
]

for (const [name, request] of cases) {
  test(`declarative parity: ${name}`, async () => {
    const [a, b] = await Promise.all([observe(nodePort, request), observe(enginePort, request)])
    assert.deepEqual(b, a)
  })
}

test("a large body to a fixed POST leaves the connection usable", async () => {
  const body = Buffer.alloc(1_200_000, 7)
  const first = Buffer.concat([
    Buffer.from(head("POST", "/ping", `content-length: ${body.length}\r\n`)),
    body,
  ])
  const second = Buffer.from(head("GET", "/ping"))
  const received = await raw(enginePort, Buffer.concat([first, second]), (text) => {
    return (text.match(/HTTP\/1\.1 200 OK/g)?.length ?? 0) >= 2
  })
  assert.equal(received.match(/HTTP\/1\.1 200 OK/g)?.length, 2)
})

test("the two spellings a router cannot echo differ off the node lane, and only those", async () => {
  // A malformed escape is a 400 from the router; the transport echoes the segment it was sent.
  const malformed = await Promise.all([
    observe(nodePort, head("GET", "/user/%zz")),
    observe(enginePort, head("GET", "/user/%zz")),
  ])
  assert.equal(malformed[0].status, 400)
  assert.equal(malformed[1].status, 200)
  assert.equal(malformed[1].body, "%zz")
  // A segment of dots written as escapes is read by a URL parser as a dot segment.
  const dots = await observe(enginePort, head("GET", "/user/%2e%2e"))
  assert.equal(dots.body, "%2e%2e")
})

test("HEAD of an echoParam route sends the headers and no body", async () => {
  const reply = await observe(enginePort, head("HEAD", "/user/abc"))
  assert.equal(reply.status, 200)
  assert.equal(reply.body, "")
  assert.ok(
    reply.headers.some(
      ([name, value]) => name === "content-type" && value.startsWith("text/plain"),
    ),
  )
})

test("echoParam sets its text headers", async () => {
  const reply = await observe(enginePort, head("GET", "/user/abc"))
  assert.deepEqual(
    reply.headers.filter(([name]) => name !== "content-length"),
    [
      ["content-type", "text/plain; charset=utf-8"],
      ["x-content-type-options", "nosniff"],
    ],
  )
  assert.equal(reply.body, "abc")
})

test("a fixed route is answered without entering the app", async () => {
  const app = makeApp()
  let entered = 0
  const resolve = app.resolveNodeSource.bind(app)
  app.resolveNodeSource = (...args) => {
    entered += 1
    return resolve(...args)
  }
  const running = await serveEngine(app, { port: 0 })
  try {
    await observe(running.port, head("GET", "/ping"))
    assert.equal((await observe(running.port, head("GET", "/user/abc"))).body, "abc")
    assert.equal(entered, 0)
    // A fixed POST without Origin/Sec-Fetch-Site is answered natively without entering JS.
    assert.equal(
      (await observe(running.port, head("POST", "/ping", "content-length: 0\r\n"))).status,
      200,
    )
    assert.equal(entered, 0)
    // One with an Origin stays on the ordinary path so cross-site form checks see it.
    const crossSite = await observe(
      running.port,
      head(
        "POST",
        "/ping",
        "origin: https://evil.test\r\ncontent-type: text/plain\r\ncontent-length: 0\r\n",
      ),
    )
    assert.equal(crossSite.status, 403)
    assert.equal(entered, 1)
    await observe(running.port, head("GET", "/dynamic"))
    assert.equal(entered, 2)
  } finally {
    await running.stop()
  }
})

test("a more specific route beside an echoParam route still wins", async () => {
  const app = server()
    .get("/user/:id", echoParam("/user/:id"))
    .get("/user/me", () => ({ profile: true }))
    .post("/other/:id", echoParam("/other/:id"))
  const running = await serveEngine(app, { port: 0 })
  try {
    assert.equal((await observe(running.port, head("GET", "/user/me"))).body, '{"profile":true}')
    assert.equal((await observe(running.port, head("GET", "/user/abc"))).body, "abc")
  } finally {
    await running.stop()
  }
})

test("a long header is answered natively, whole", async () => {
  const app = server()
    .get("/long", staticResponse({ headers: { "x-long": "a".repeat(256) } }))
    .get("/edge", staticResponse({ headers: { "x-edge": "a".repeat(255) } }))
  let entered = 0
  const resolve = app.resolveNodeSource.bind(app)
  app.resolveNodeSource = (...args) => {
    entered += 1
    return resolve(...args)
  }
  const running = await serveEngine(app, { port: 0 })
  try {
    const edge = await observe(running.port, head("GET", "/edge"))
    assert.equal(edge.status, 200)
    assert.equal(entered, 0)
    const long = await observe(running.port, head("GET", "/long"))
    assert.equal(long.status, 200)
    assert.ok(long.headers.some(([name, value]) => name === "x-long" && value.length === 256))
    assert.equal(entered, 0)
  } finally {
    await running.stop()
  }
})

test("a header uWS frames itself is not sent twice, with or without an Origin", async () => {
  const stale = "Mon, 01 Jan 2001 00:00:00 GMT"
  const app = server()
    .get("/dated", staticResponse({ headers: { date: stale } }))
    .post("/dated", staticResponse({ headers: { date: stale } }))
  const running = await serveEngine(app, { port: 0 })
  try {
    for (const [method, extra] of [
      ["GET", ""],
      ["POST", "Content-Length: 0\r\n"],
      ["POST", "Content-Length: 0\r\nOrigin: http://example.test\r\n"],
    ] as const) {
      const text = await raw(running.port, head(method, "/dated", extra), (received) =>
        received.includes("\r\n\r\n"),
      )
      const dates = parseHead(text).headers.get("date") ?? []
      assert.equal(dates.length, 1, `${method} ${extra}`)
      assert.notEqual(dates[0], stale)
    }
  } finally {
    await running.stop()
  }
})

test("HEAD of a fixed GET route keeps its headers and sends no body", async () => {
  const reply = await observe(enginePort, head("HEAD", "/ping"))
  assert.equal(reply.status, 200)
  assert.equal(reply.body, "")
  assert.deepEqual(
    reply.headers.filter(([name]) => name !== "content-length"),
    [
      ["cache-control", "no-store"],
      ["x-fixed", "1"],
    ],
  )
})

test("an onRequest hook sees the request: the route is not answered natively", async () => {
  const app = server()
    .onRequest(() => {})
    .get("/ping", staticResponse())
  let seen = 0
  app.onRequest(() => {
    seen += 1
  })
  const running = await serveEngine(app, { port: 0 })
  try {
    const reply = await observe(running.port, head("GET", "/ping"))
    assert.equal(reply.status, 200)
    assert.equal(seen, 1)
  } finally {
    await running.stop()
  }
})

test("a host policy keeps fixed routes on the ordinary path", async () => {
  const running = await serveEngine(makeApp(), { port: 0, allowedHosts: ["example.test"] })
  try {
    const allowed = await observe(running.port, head("GET", "/ping"))
    assert.equal(allowed.status, 200)
    const refused = await observe(
      running.port,
      "GET /ping HTTP/1.1\r\nHost: elsewhere.test\r\n\r\n",
    )
    assert.equal(refused.status, 400)
  } finally {
    await running.stop()
  }
})

test("validateHost keeps fixed routes on the ordinary path, where Host is checked", async () => {
  const running = await serveEngine(makeApp(), { port: 0, validateHost: true })
  try {
    assert.equal((await observe(running.port, head("GET", "/ping"))).status, 200)
    const refused = await observe(
      running.port,
      "GET /ping HTTP/1.1\r\nHost: example.test:99999\r\n\r\n",
    )
    assert.equal(refused.status, 400)
  } finally {
    await running.stop()
  }
})

test("serving seals the app: a route added afterwards cannot be skipped", async () => {
  const app = makeApp()
  const running = await serveEngine(app, { port: 0 })
  try {
    assert.throws(() => app.get("/late", () => "late"), /sealed/)
  } finally {
    await running.stop()
  }
})

test("a socket route on the same path keeps its handshake", async () => {
  const app = server()
    .use(websocket())
    .get("/live", staticResponse())
    .ws("/live", { message: () => {} })
  const running = await serveEngine(app, { port: 0 })
  try {
    const reply = await observe(
      running.port,
      head(
        "GET",
        "/live",
        "connection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n",
      ),
    )
    assert.equal(reply.status, 101)
  } finally {
    await running.stop()
  }
})
