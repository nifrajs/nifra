/**
 * Per-framework reverse-proxy server for the NODE section, selected by CLI arg, forwarding to the
 * same upstream origin as every other row. Run by Node (v24 strips TS types natively - no build
 * step), spawned as an isolated subprocess by run.ts.
 *
 *   fastify   - `@fastify/http-proxy` (its official plugin, undici-backed)
 *   hono      - `hono/proxy` behind the same hand-rolled node:http ↔ Web bridge bench/http uses,
 *               so the row is not taxed by a third-party adapter nobody chose
 *   node-raw  - `http.request` + `pipe`, NO hygiene and no Web Request/Response round trip: the
 *               ceiling. Node's own streams end to end, which is as fast as forwarding gets here.
 *
 * nifra's Node row lives in serve-node-nifra.ts - it needs a Node-targeted bundle first (real Node
 * cannot resolve the @nifrajs/* workspace), so run.ts builds it separately.
 *
 *   node bench/proxy/serve-node.ts <fastify|hono|node-raw> <port> <upstreamPort>
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import { createServer, request as httpRequest } from "node:http"
import { Readable } from "node:stream"

const framework = process.argv[2]
const port = Number(process.argv[3])
const upstreamPort = Number(process.argv[4])

if (!Number.isInteger(port) || !Number.isInteger(upstreamPort)) {
  throw new Error("usage: node bench/proxy/serve-node.ts <fastify|hono|node-raw> <port> <upstream>")
}

const upstream = `http://127.0.0.1:${upstreamPort}`

// Duplicated (not imported) so this file stays independently runnable under Node - the same
// convention bench/http/serve-node.ts follows.
function toWebRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? "localhost"
  const url = `http://${host}${req.url ?? "/"}`
  const method = req.method ?? "GET"
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    headers.set(key, Array.isArray(value) ? value.join(", ") : value)
  }
  const init: RequestInit & { duplex?: "half" } = { method, headers }
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>
    init.duplex = "half"
  }
  return new Request(url, init)
}

async function writeWebResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {}
  response.headers.forEach((value, key) => {
    headers[key] = value
  })
  const setCookies = response.headers.getSetCookie?.()
  if (setCookies !== undefined && setCookies.length > 0) headers["set-cookie"] = setCookies
  res.writeHead(response.status, headers)
  if (response.body !== null) {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(value)
    }
  }
  res.end()
}

if (framework === "fastify") {
  const { default: Fastify } = await import("fastify")
  const { default: proxy } = await import("@fastify/http-proxy")
  const app = Fastify()
  await app.register(proxy, { upstream, prefix: "/" })
  await app.listen({ port, host: "127.0.0.1" })
} else if (framework === "hono") {
  const { Hono } = await import("hono")
  const { proxy } = await import("hono/proxy")
  const app = new Hono().all("/*", (c) => {
    const url = new URL(c.req.url)
    return proxy(`${upstream}${url.pathname}${url.search}`, c.req.raw)
  })
  createServer((req, res) => {
    void Promise.resolve(app.fetch(toWebRequest(req))).then(
      (settled) => writeWebResponse(settled, res),
      () => {
        res.writeHead(500, { "content-type": "application/json" })
        res.end('{"error":"internal"}')
      },
    )
  }).listen(port)
} else if (framework === "node-raw") {
  createServer((req, res) => {
    const forwarded = httpRequest(
      {
        port: upstreamPort,
        host: "127.0.0.1",
        path: req.url ?? "/",
        method: req.method,
        headers: req.headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        upstreamRes.pipe(res)
      },
    )
    forwarded.on("error", () => {
      res.writeHead(502, { "content-type": "application/json" })
      res.end('{"error":"bad_gateway"}')
    })
    req.pipe(forwarded)
  }).listen(port)
} else {
  throw new Error(`unknown framework "${framework}" (fastify | hono | node-raw)`)
}
