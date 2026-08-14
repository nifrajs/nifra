/**
 * nifra's reverse proxy on Node - `@nifrajs/proxy` mounted on a nifra server, served through
 * `@nifrajs/node`'s `serve()` (Node `http` ↔ Web-standard `app.fetch`).
 *
 * Run as a Node-targeted BUNDLE: real Node cannot resolve the `@nifrajs/*` workspace packages
 * (Bun resolves them via tsconfig paths, which Node ignores), so run.ts builds this with
 * `Bun.build({ target: "node" })` first - which is also nifra's actual Node deploy path. The
 * per-request Web Request/Response adaptation is real overhead this row honestly pays.
 *
 * The mode arg selects how much of the stack is in the path, so the remaining distance to
 * `@fastify/http-proxy` can be attributed to a layer instead of guessed at. Each mode adds exactly
 * one thing to the one above it:
 *
 *   web-undici  - a hand-rolled node:http ↔ Web bridge (the same one hono's row uses) straight onto
 *                 the undici transport. NO hygiene, no nifra. Against `node-raw` this is the price
 *                 of the Web Request/Response round trip alone.
 *   bare-undici - the same bridge, but through `createProxy`. Adds header hygiene, the deadline,
 *                 and forwarding-metadata suppression, and nothing else.
 *   serve-undici- that same `createProxy` handler, but bridged by `@nifrajs/node`'s `serve()`
 *                 instead of the hand-rolled bridge, with NO nifra server. Against `bare-undici`
 *                 this is the adapter alone; against `undici`, the difference is the server.
 *   undici      - the real deployment: nifra server + `@nifrajs/node`'s `serve()`, undici transport.
 *   fetch       - the same, on the default `fetch` transport.
 *
 * `undici` stays external to the bundle so Node loads the real package (bench's own devDep) rather
 * than an inlined copy of a client that carries wasm.
 *
 *   node <bundled serve-node-nifra.js> <port> <upstreamPort> [fetch|undici|bare-undici|web-undici]
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import { createServer } from "node:http"
import { Readable } from "node:stream"
import { server } from "@nifrajs/core"
import { serve } from "@nifrajs/node"
import { createProxy, type ProxyOptions } from "@nifrajs/proxy"
import { undiciTransport } from "@nifrajs/proxy/undici"

const MODES = ["fetch", "undici", "serve-undici", "bare-undici", "web-undici"] as const
type Mode = (typeof MODES)[number]

const port = Number(process.argv[2])
const upstreamPort = Number(process.argv[3])
const mode = (process.argv[4] ?? "fetch") as Mode
if (!Number.isInteger(port) || !Number.isInteger(upstreamPort)) {
  throw new Error(
    `usage: node <bundled serve-node-nifra.js> <port> <upstreamPort> [${MODES.join("|")}]`,
  )
}
if (!MODES.includes(mode)) {
  throw new Error(`unknown mode "${mode}" (${MODES.join(" | ")})`)
}

const upstream = `http://127.0.0.1:${upstreamPort}`

// Duplicated (not imported) so the probe rows measure the SAME bridge hono's row is measured
// through - importing @nifrajs/node here would fold the adapter back into the row it isolates.
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

function bridge(handler: (req: Request) => Promise<Response>): void {
  createServer((req, res) => {
    void handler(toWebRequest(req)).then(
      (settled) => writeWebResponse(settled, res),
      () => {
        res.writeHead(500, { "content-type": "application/json" })
        res.end('{"error":"internal"}')
      },
    )
  }).listen(port)
}

if (mode === "web-undici") {
  const transport = undiciTransport()
  const origin = new URL(upstream)
  // No AbortController per request either: this row is the floor for "Web objects in the path",
  // so everything createProxy adds belongs to the row below, not to this one.
  const signal = new AbortController().signal
  bridge(async (req) => {
    const incoming = new URL(req.url)
    const target = new URL(origin)
    target.pathname = incoming.pathname
    target.search = incoming.search
    const upstreamResponse = await transport(target, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal,
    })
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: upstreamResponse.headers,
    })
  })
} else if (mode === "bare-undici") {
  bridge(createProxy({ upstream, transport: undiciTransport() }))
} else if (mode === "serve-undici") {
  // `serve()` takes any `{ fetch }`, so the proxy handler runs with the real adapter and no router.
  await serve({ fetch: createProxy({ upstream, transport: undiciTransport() }) }, { port })
} else {
  const options: ProxyOptions = {
    upstream,
    ...(mode === "undici" ? { transport: undiciTransport() } : {}),
  }
  const app = server().mountFetch("/", createProxy(options))
  await serve(app, { port })
}
