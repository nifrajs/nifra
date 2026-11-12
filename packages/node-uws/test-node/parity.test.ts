/**
 * The same app behind `@nifrajs/node` and `@nifrajs/node-uws`: for every request below the two must
 * answer alike - status, body, and every header the app set. Headers a transport adds on its own
 * (`date`, `server`-style banners, connection framing) are not part of the app's answer and are left out.
 */
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { server, status } from "@nifrajs/core"
import { serve as serveNode } from "@nifrajs/node"
import { serve as serveUws } from "../src/index.ts"
import { AUTH, parseHead, raw } from "./support.ts"

function makeApp() {
  return server()
    .use({
      name: "headers",
      beforeHandle: (c) => {
        c.set.headers["x-content-type-options"] = "nosniff"
        c.set.headers.vary = "Origin"
      },
    })
    .derive((c) => {
      const auth = c.header("authorization")
      if (auth === null || !auth.startsWith("Bearer ")) {
        return status(401, { ok: false, error: "unauthorized" })
      }
      return { userId: auth.slice(7, 19), theme: c.cookies.theme ?? "light" }
    })
    .get("/orders", (c) => ({ user: c.userId, theme: c.theme, q: c.query }))
    .get("/echo-url", (c) => ({ url: c.req.url, ip: typeof c.clientIp }))
    .get("/cookies", (c) => {
      c.set.cookie("a", "1", { path: "/" })
      c.set.cookie("b", "2", { path: "/" })
      return { ok: true }
    })
    .get("/text", () => new Response("plain text", { headers: { "content-type": "text/plain" } }))
    .get("/bytes", () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 201 }))
    .get("/empty", () => new Response(null, { status: 204 }))
    .get("/redirect", () => new Response(null, { status: 302, headers: { location: "/orders" } }))
    .get("/slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { slow: true }
    })
    .get("/async-header", async (c) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { header: c.header("x-late") }
    })
    .post("/json", async (c) => {
      const body: { n: number } = await c.req.json()
      return { doubled: body.n * 2 }
    })
    .post("/raw", async (c) => {
      const bytes = new Uint8Array(await c.req.arrayBuffer())
      return { length: bytes.byteLength, sum: bytes.reduce((a, b) => a + b, 0) }
    })
    .get("/throws", () => {
      throw new Error("boom")
    })
}

let nodePort = 0
let uwsPort = 0
const stops: Array<() => Promise<void>> = []

before(async () => {
  const a = await serveNode(makeApp(), { port: 0, hostname: "127.0.0.1" })
  const b = await serveUws(makeApp(), { port: 0, hostname: "127.0.0.1" })
  nodePort = a.port
  uwsPort = b.port
  stops.push(
    () => a.stop({ drainMs: 0 }),
    () => b.stop({ drainMs: 0 }),
  )
})

after(async () => {
  for (const stop of stops) await stop()
})

const SKIP = new Set(["date", "connection", "keep-alive", "uwebsockets", "x-request-id"])

interface Observed {
  status: number
  headers: Array<[string, string]>
  body: string
}

async function observe(port: number, request: string | Buffer): Promise<Observed> {
  const text = await raw(port, request, (received) => {
    const parsed = parseHead(received)
    const length = Number(parsed.headers.get("content-length")?.[0] ?? Number.NaN)
    const head = /^HEAD /.test(request.toString("latin1"))
    return (
      received.includes("\r\n\r\n") &&
      (head || Number.isNaN(length) || parsed.body.length >= length)
    )
  })
  const parsed = parseHead(text)
  const headers: Array<[string, string]> = []
  for (const [name, values] of parsed.headers) {
    if (SKIP.has(name)) continue
    for (const value of values) headers.push([name, value])
  }
  headers.sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]))
  return { status: parsed.status, headers, body: parsed.body }
}

function get(path: string, extra = ""): string {
  return `GET ${path} HTTP/1.1\r\nHost: example.test\r\nauthorization: ${AUTH}\r\n${extra}\r\n`
}

function post(path: string, body: string | Buffer, extra = ""): Buffer {
  const payload = Buffer.from(body)
  return Buffer.concat([
    Buffer.from(
      `POST ${path} HTTP/1.1\r\nHost: example.test\r\nauthorization: ${AUTH}\r\ncontent-length: ${payload.length}\r\n${extra}\r\n`,
    ),
    payload,
  ])
}

const cases: Array<[string, string | Buffer]> = [
  ["GET with auth, cookie and query", get("/orders?limit=3&x=a%20b", "cookie: theme=dark\r\n")],
  ["GET without auth is 401", "GET /orders HTTP/1.1\r\nHost: example.test\r\n\r\n"],
  ["request URL carries the Host", get("/echo-url?z=1")],
  ["two cookies, two set-cookie lines", get("/cookies")],
  ["Response with text body", get("/text")],
  ["Response with bytes and status", get("/bytes")],
  ["204 has no body or length", get("/empty")],
  ["redirect", get("/redirect")],
  ["unknown route is 404", get("/nope")],
  [
    "HEAD of a json route",
    "HEAD /orders HTTP/1.1\r\nHost: example.test\r\nauthorization: " + AUTH + "\r\n\r\n",
  ],
  ["async route", get("/slow")],
  ["header read after an await", get("/async-header", "x-late: still-here\r\n")],
  ["POST json", post("/json", '{"n":21}', "content-type: application/json\r\n")],
  ["POST malformed json", post("/json", "{nope", "content-type: application/json\r\n")],
  ["POST binary body", post("/raw", Buffer.from([1, 2, 3, 250, 251]))],
  ["POST empty body", post("/raw", "")],
  [
    "POST chunked body",
    Buffer.from(
      `POST /raw HTTP/1.1\r\nHost: example.test\r\nauthorization: ${AUTH}\r\ntransfer-encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n`,
    ),
  ],
  ["handler that throws is a 500", get("/throws")],
  ["body over the 1 MB cap is 413", post("/raw", Buffer.alloc(1_200_000, 1))],
]

for (const [name, request] of cases) {
  test(`parity: ${name}`, async () => {
    const [a, b] = await Promise.all([observe(nodePort, request), observe(uwsPort, request)])
    assert.deepEqual(b, a)
  })
}
