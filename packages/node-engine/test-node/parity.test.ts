/**
 * The same app behind node-engine, node:http and, when enabled, Deno.serve.
 * Compare status, body, and every header the app set. Headers a transport adds on its own
 * (`date`, `server`-style banners, connection framing) are not part of the app's answer and are left out.
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createInterface } from "node:readline"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { serve as serveNode } from "@nifrajs/node"
import { serve as serveEngine } from "../src/index.ts"
import { makeApp } from "./fixtures/parity-app.ts"
import { AUTH, parseHead, raw } from "./support.ts"

let nodePort = 0
let enginePort = 0
const stops: Array<() => Promise<void>> = []

before(async () => {
  const a = await serveNode(makeApp(), { port: 0, hostname: "127.0.0.1" })
  stops.push(() => a.stop({ drainMs: 0 }))
  const b = await serveEngine(makeApp(), { port: 0, hostname: "127.0.0.1" })
  stops.push(() => b.stop({ drainMs: 0 }))
  nodePort = a.port
  enginePort = b.port
})

after(async () => {
  for (const stop of stops) await stop()
})

const SKIP = new Set(["date", "connection", "keep-alive", "x-request-id"])

/** The payload of a chunked body: transfer framing is how it travelled, not what the application sent. */
function dechunk(wire: string): string {
  let out = ""
  let at = 0
  for (;;) {
    const eol = wire.indexOf("\r\n", at)
    assert.ok(eol !== -1, "a chunked body ended without its last chunk")
    const size = Number.parseInt(wire.slice(at, eol).split(";")[0] ?? "", 16)
    assert.ok(Number.isFinite(size), "a chunk size is not hexadecimal")
    if (size === 0) return out
    assert.equal(wire.slice(eol + 2 + size, eol + 4 + size), "\r\n", "a chunk is cut short")
    out += wire.slice(eol + 2, eol + 2 + size)
    at = eol + 2 + size + 2
  }
}

interface Observed {
  status: number
  headers: Array<[string, string]>
  body: string
}

async function observe(port: number, request: string | Buffer): Promise<Observed> {
  const text = await raw(port, request, (received) => {
    const parsed = parseHead(received)
    if (!received.includes("\r\n\r\n")) return false
    if (
      /^HEAD /.test(request.toString("latin1")) ||
      parsed.status === 204 ||
      parsed.status === 304
    ) {
      return true
    }
    if (parsed.headers.get("transfer-encoding")?.[0]?.toLowerCase() === "chunked") {
      return parsed.body.endsWith("0\r\n\r\n")
    }
    const length = Number(parsed.headers.get("content-length")?.[0] ?? Number.NaN)
    return !Number.isNaN(length) && parsed.body.length >= length
  })
  const parsed = parseHead(text)
  const chunked = parsed.headers.get("transfer-encoding")?.[0]?.toLowerCase() === "chunked"
  const body = chunked ? dechunk(parsed.body) : parsed.body
  // A HEAD or bodyless answer's length is part of the reply; elsewhere it only frames the body.
  const lengthMatters = /^HEAD /.test(request.toString("latin1")) || parsed.status === 204
  const declared = parsed.headers.get("content-length")?.[0]
  const bodyless = /^HEAD /.test(request.toString("latin1")) || [204, 304].includes(parsed.status)
  if (!chunked && !bodyless && declared !== undefined) {
    assert.equal(parsed.body.length, Number(declared), "the body is not the declared length")
  }
  const headers: Array<[string, string]> = []
  for (const [name, values] of parsed.headers) {
    if (SKIP.has(name) || name === "transfer-encoding") continue
    if (name === "content-length" && !lengthMatters) continue
    for (const value of values) headers.push([name, value])
  }
  headers.sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]))
  return { status: parsed.status, headers, body }
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
]

for (const [name, request] of cases) {
  test(`parity: ${name}`, async () => {
    const [a, b] = await Promise.all([observe(nodePort, request), observe(enginePort, request)])
    assert.deepEqual(b, a)
  })
}

test("parity with the live Deno adapter", {
  skip: process.env.NIFRA_ENGINE_TEST_DENO !== "1",
  timeout: 30_000,
}, async (t) => {
  const fixture = fileURLToPath(new URL("./fixtures/deno-server.ts", import.meta.url))
  const worker = spawn(
    "deno",
    ["run", "--cached-only", "--allow-env=NODE_ENV", "--allow-net=127.0.0.1", fixture],
    { stdio: ["ignore", "pipe", "inherit"] },
  )
  const exited = once(worker, "close")
  // A startup error is reported by the race below, and cleanup can still await the child.
  exited.catch(() => {})
  const lines = createInterface({ input: worker.stdout })
  try {
    const port = await Promise.race([
      once(lines, "line", { signal: t.signal }).then(([line]) => {
        assert.match(line, /^\d+$/)
        return Number(line)
      }),
      exited.then(([code]) => {
        throw new Error(`Deno parity fixture exited before listening (code ${code})`)
      }),
    ])
    for (const [name, request] of cases) {
      await t.test(name, async () => {
        const [deno, engine] = await Promise.all([
          observe(port, request),
          observe(enginePort, request),
        ])
        assert.deepEqual(engine, deno)
      })
    }
  } finally {
    lines.close()
    worker.kill()
    await exited
  }
})
