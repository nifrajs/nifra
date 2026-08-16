import { connect } from "node:net"
import { nodeDirect } from "../packages/core/src/node-direct.ts"
import { responseObserver } from "../packages/core/src/response-observer.ts"
import { nodeOutcomeToResponse } from "../packages/core/src/server/node-outcome.ts"
import { server } from "../packages/core/src/server.ts"
import { type NodeServer, serve } from "../packages/node/src/index.ts"

const RESPONSE_RESULT = Symbol.for("nifra.response.result")

type RawResponse = {
  readonly status: number
  readonly headers: Readonly<Record<string, readonly string[]>>
  readonly body: Uint8Array
}

type Law = {
  readonly name: string
  readonly run: (app: ReturnType<typeof conformanceApp>, port: number) => Promise<void>
}

function fail(message: string): never {
  throw new Error(`node outcome law failed: ${message}`)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message)
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) fail(`${message}; expected ${String(expected)}, got ${String(actual)}`)
}

function assertBytes(actual: Uint8Array, expected: string, message: string): void {
  assertEqual(new TextDecoder().decode(actual), expected, message)
}

function conformanceApp() {
  return server()
    .use(nodeDirect())
    .use(responseObserver())
    .onResponseHeaders((headers) => {
      headers.append("X-Merged", "first")
      headers.append("x-merged", "second")
    })
    .get("/json", (c) => {
      c.set.headers["X-Mixed-Case"] = "kept"
      c.set.cookie("sid", "a")
      c.set.cookie("csrf", "b")
      return { ok: true }
    })
    .get("/body", () => ({
      [RESPONSE_RESULT]: true,
      toResponse() {
        return new Response("body", { status: 201 })
      },
      toNodeBody() {
        return {
          status: 201,
          headers: {
            "X-Mixed-Case": "kept",
            "set-cookie": ["existing=1; Path=/", "another=2; Path=/"],
          },
          body: "body",
        }
      },
    }))
    .get("/response", () => new Response("response", { status: 202 }))
    .get("/empty", (c) => {
      c.set.status = 204
      c.set.headers["Content-Length"] = "999"
      return { stale: true }
    })
    .get("/not-modified", (c) => {
      c.set.status = 304
      c.set.headers["content-length"] = "999"
      return { stale: true }
    })
    .get("/head", () => ({ head: true }))
}

async function readRawResponse(
  port: number,
  method: "GET" | "HEAD",
  path: string,
): Promise<RawResponse> {
  return await new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1")
    const chunks: Buffer[] = []
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }
    socket.setTimeout(3000, () => {
      socket.destroy()
      settle(() => reject(new Error(`timed out reading ${method} ${path}`)))
    })
    socket.on("error", (error) => settle(() => reject(error)))
    socket.on("connect", () => {
      socket.write(`${method} ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`)
    })
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
    socket.on("end", () => {
      settle(() => {
        const raw = Buffer.concat(chunks)
        const separator = raw.indexOf("\r\n\r\n")
        if (separator < 0) throw new Error(`malformed response for ${method} ${path}`)
        const lines = raw.subarray(0, separator).toString("latin1").split("\r\n")
        const status = Number(lines[0]?.split(" ")[1])
        if (!Number.isInteger(status)) throw new Error(`missing status for ${method} ${path}`)
        const headers: Record<string, string[]> = Object.create(null) as Record<string, string[]>
        for (const line of lines.slice(1)) {
          const colon = line.indexOf(":")
          if (colon < 0) continue
          const name = line.slice(0, colon).toLowerCase()
          const value = line.slice(colon + 1).trim()
          const values = headers[name]
          if (values === undefined) headers[name] = [value]
          else values.push(value)
        }
        resolve({ status, headers, body: raw.subarray(separator + 4) })
      })
    })
  })
}

function onlyHeader(response: RawResponse, name: string): string | undefined {
  const values = response.headers[name]
  return values?.length === 1 ? values[0] : undefined
}

const LAWS: readonly Law[] = [
  {
    name: "core-producer-variants",
    async run(app) {
      const json = await app.resolveNode(new Request("http://localhost/json"))
      assertEqual(json.kind, "json", "plain data must produce json outcome")
      if (json.kind !== "json") return
      assertEqual(json.status, 200, "json outcome status")
      assertEqual(json.body, JSON.stringify({ ok: true }), "json outcome body")
      assert(Array.isArray(json.cookies) && json.cookies.length === 2, "json cookies stay separate")
      assertEqual(json.headers?.["X-Mixed-Case"], "kept", "producer retains declared header")

      const body = await app.resolveNode(new Request("http://localhost/body"))
      assertEqual(body.kind, "body", "buffered response must produce body outcome")
      if (body.kind !== "body") return
      assertEqual(body.status, 201, "body outcome status")
      assertEqual(body.body, "body", "body outcome bytes")

      const response = await app.resolveNode(new Request("http://localhost/response"))
      assertEqual(response.kind, "response", "raw response must produce response outcome")
      if (response.kind !== "response") return
      assertEqual(response.response.status, 202, "response outcome status")
      assertEqual(await response.response.text(), "response", "response outcome body")
    },
  },
  {
    name: "core-materialization-preserves-header-laws",
    async run(app) {
      const json = await app.resolveNode(new Request("http://localhost/json"))
      assertEqual(json.kind, "json", "materialization input must be json outcome")
      if (json.kind !== "json") return
      const materialized = nodeOutcomeToResponse(json)
      assertEqual(
        materialized.headers.get("x-mixed-case"),
        "kept",
        "materialization normalizes case",
      )
      assertEqual(
        materialized.headers.get("x-merged"),
        "first, second",
        "materialization merges repeated values",
      )
      assertEqual(
        materialized.headers.getSetCookie().length,
        2,
        "materialization keeps cookies separate",
      )
      assertEqual(await materialized.text(), JSON.stringify({ ok: true }), "materialized body")

      const body = await app.resolveNode(new Request("http://localhost/body"))
      assertEqual(body.kind, "body", "body materialization input")
      if (body.kind !== "body") return
      const bodyResponse = nodeOutcomeToResponse(body)
      assertEqual(
        bodyResponse.headers.get("x-mixed-case"),
        "kept",
        "body materialization normalizes case",
      )
      assertEqual(
        bodyResponse.headers.get("x-merged"),
        "first, second",
        "body materialization merges values",
      )
      assertEqual(
        bodyResponse.headers.getSetCookie().length,
        2,
        "body materialization keeps cookies",
      )
      assertEqual(await bodyResponse.text(), "body", "materialized buffered body")
    },
  },
  {
    name: "socket-header-case-duplicates-and-cookies",
    async run(_app, port) {
      const json = await readRawResponse(port, "GET", "/json")
      assertEqual(json.status, 200, "json socket status")
      assertEqual(onlyHeader(json, "x-mixed-case"), "kept", "socket lowercases header names")
      assertEqual(
        json.headers["x-merged"]?.join("|"),
        "first, second",
        "socket merges duplicate headers",
      )
      assertEqual(json.headers["set-cookie"]?.length, 2, "socket keeps multiple cookies")
      assertBytes(json.body, JSON.stringify({ ok: true }), "json socket body")

      const body = await readRawResponse(port, "GET", "/body")
      assertEqual(body.status, 201, "body socket status")
      assertEqual(
        body.headers["x-merged"]?.join("|"),
        "first, second",
        "body merges duplicate headers",
      )
      assertEqual(body.headers["set-cookie"]?.length, 2, "body keeps duplicate cookies")
      assertBytes(body.body, "body", "body socket bytes")
    },
  },
  {
    name: "socket-buffered-content-length-framing",
    async run(_app, port) {
      const json = await readRawResponse(port, "GET", "/json")
      assertEqual(
        onlyHeader(json, "transfer-encoding"),
        undefined,
        "json must not use chunked framing",
      )
      assertEqual(
        onlyHeader(json, "content-length"),
        String(json.body.byteLength),
        "json content length",
      )

      const body = await readRawResponse(port, "GET", "/body")
      assertEqual(
        onlyHeader(body, "transfer-encoding"),
        undefined,
        "body must not use chunked framing",
      )
      assertEqual(
        onlyHeader(body, "content-length"),
        String(body.body.byteLength),
        "body content length",
      )
    },
  },
  {
    name: "socket-bodyless-statuses-have-no-stale-framing",
    async run(_app, port) {
      for (const path of ["/empty", "/not-modified"]) {
        const response = await readRawResponse(port, "GET", path)
        assertEqual(response.body.byteLength, 0, `${path} bodyless wire body`)
        assert(
          !response.headers["content-length"]?.includes("999"),
          `${path} has no stale content length`,
        )
        assertEqual(
          response.headers["transfer-encoding"],
          undefined,
          `${path} has no transfer framing`,
        )
      }
    },
  },
  {
    name: "socket-head-emits-no-body",
    async run(_app, port) {
      const get = await readRawResponse(port, "GET", "/head")
      const head = await readRawResponse(port, "HEAD", "/head")
      assertEqual(head.status, get.status, "HEAD status mirrors GET")
      assertEqual(
        onlyHeader(head, "content-length"),
        String(get.body.byteLength),
        "HEAD advertises GET length",
      )
      assertEqual(head.body.byteLength, 0, "HEAD emits no body")
      assertEqual(head.headers["transfer-encoding"], undefined, "HEAD does not use chunked framing")
    },
  },
]

export async function runNodeOutcomeConformance(): Promise<void> {
  const app = conformanceApp()
  let running: NodeServer | undefined
  try {
    for (const law of LAWS.slice(0, 2)) await law.run(app, 0)
    running = await serve(app, { port: 0 })
    for (const law of LAWS.slice(2)) await law.run(app, running.port)
  } finally {
    await running?.stop({ drainMs: 0 })
  }
}

if (import.meta.main) {
  await runNodeOutcomeConformance()
  console.log(`✓ Node outcome conformance (${LAWS.length} laws)`)
}
