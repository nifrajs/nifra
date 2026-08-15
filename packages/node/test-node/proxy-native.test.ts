import assert from "node:assert/strict"
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http"
import { after, before, test } from "node:test"
import { type NodeServer, serve } from "@nifrajs/node"

// @nifrajs/node intentionally has no runtime dependencies on @nifrajs/core or @nifrajs/proxy; load
// the built siblings directly so this Node-only integration test does not alter production deps.
const { server } = await import("../../core/dist/index.js")
const { createProxy } = await import("../../proxy/dist/index.js")

interface Exchange {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

let upstream: Server
let upstreamPort = 0
let proxyServer: NodeServer
let proxyPort = 0
let lastUpstream: { url: string; body: string; headers: IncomingHttpHeaders } | undefined

function exchange(
  port: number,
  path: string,
  options: {
    readonly method?: string
    readonly headers?: Record<string, string>
    readonly body?: string
  } = {},
): Promise<Exchange> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (chunk: Buffer) => chunks.push(chunk))
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        )
      },
    )
    req.on("error", reject)
    if (options.body !== undefined) req.end(options.body)
    else req.end()
  })
}

before(async () => {
  upstream = createServer((req, res) => {
    if (req.url === "/slow") {
      setTimeout(() => res.end("late"), 100)
      return
    }
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      lastUpstream = {
        url: req.url ?? "/",
        body: Buffer.concat(chunks).toString("utf8"),
        headers: req.headers,
      }
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "http://evil.invalid/next" })
        res.end()
        return
      }
      res.writeHead(200, {
        connection: "x-response-leak",
        "x-response-leak": "secret",
        "set-cookie": ["a=1; Path=/", "b=2; Path=/"],
        "content-type": "application/json",
      })
      res.end(JSON.stringify({ ok: true, body: lastUpstream.body }))
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  upstreamPort = (upstream.address() as { port: number }).port

  const proxy = createProxy({ upstream: `http://127.0.0.1:${upstreamPort}` })
  const app = server().mountFetch("/edge", proxy, { stripPrefix: true })
  proxyServer = await serve(app, { port: 0, hostname: "127.0.0.1" })
  proxyPort = proxyServer.port
})

after(async () => {
  await proxyServer.stop({ drainMs: 0 })
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
})

test("native mounted proxy keeps Node streams and proxy security behavior on Node", async () => {
  const response = await exchange(proxyPort, "/edge/users?x=1", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      connection: "x-request-leak, keep-alive",
      "x-request-leak": "secret",
      "proxy-authorization": "Basic secret",
      "x-forwarded-for": "198.51.100.1",
    },
    body: '{"name":"Ada"}',
  })
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), { ok: true, body: '{"name":"Ada"}' })
  assert.equal(lastUpstream?.url, "/users?x=1")
  assert.equal(lastUpstream?.body, '{"name":"Ada"}')
  assert.equal(lastUpstream?.headers["x-request-leak"], undefined)
  assert.equal(lastUpstream?.headers["proxy-authorization"], undefined)
  assert.equal(lastUpstream?.headers["x-forwarded-for"], undefined)
  assert.equal(response.headers["x-response-leak"], undefined)
  assert.deepEqual(response.headers["set-cookie"], ["a=1; Path=/", "b=2; Path=/"])
})

test("native mounted proxy relays redirects and turns header deadlines into 504", async () => {
  const redirect = await exchange(proxyPort, "/edge/redirect")
  assert.equal(redirect.status, 302)
  assert.equal(redirect.headers.location, "http://evil.invalid/next")

  const slowProxy = createProxy({
    upstream: `http://127.0.0.1:${upstreamPort}`,
    timeoutMs: 20,
  })
  const slowServer = await serve(server().mountFetch("/edge", slowProxy, { stripPrefix: true }), {
    port: 0,
    hostname: "127.0.0.1",
  })
  try {
    const timeout = await exchange(slowServer.port, "/edge/slow")
    assert.equal(timeout.status, 504)
    assert.deepEqual(JSON.parse(timeout.body), { ok: false, error: "gateway_timeout" })
  } finally {
    await slowServer.stop({ drainMs: 0 })
  }
})

test("global response middleware keeps a mounted proxy on the portable fallback", async () => {
  const proxy = createProxy({ upstream: `http://127.0.0.1:${upstreamPort}` })
  const hooked = server()
    .onResponse((response) => {
      response.headers.set("x-hook", "ran")
      return response
    })
    .mountFetch("/edge", proxy, { stripPrefix: true })
  const hookedServer = await serve(hooked, { port: 0, hostname: "127.0.0.1" })
  try {
    const response = await exchange(hookedServer.port, "/edge/hooked")
    assert.equal(response.status, 200)
    assert.equal(response.headers["x-hook"], "ran")
  } finally {
    await hookedServer.stop({ drainMs: 0 })
  }
})
