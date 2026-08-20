/**
 * Conformance for `@nifrajs/proxy/undici` - the SECOND implementation of the upstream hop.
 *
 * This lives on the Node lane (`bun run test:node`) rather than beside the Bun suite because it
 * cannot run under Bun at all: there the `undici` specifier resolves to a built-in shim, which is
 * why `undiciTransport()` refuses to construct on that runtime. The Bun suite covers that refusal.
 *
 * Every security property `createProxy` advertises is re-asserted here rather than assumed. A
 * transport swap moves redirect handling, header relay, and body framing onto different code, and
 * the hop-by-hop leak this package exists to prevent (CVE-2026-33805 / CVE-2026-71849 class) is
 * exactly the kind of bug that survives a transport swap unnoticed.
 */

import assert from "node:assert/strict"
import http from "node:http"
import { after, before, describe, test } from "node:test"
import { createProxy, type ProxyTransport } from "@nifrajs/proxy"
import { undiciTransport } from "@nifrajs/proxy/undici"

// Bun's runner takes path arguments as substring filters, so the Bun lane's `packages/proxy/test`
// also sweeps in `test-node`. Self-skip rather than depend on the caller spelling it precisely.
const underBun = typeof (globalThis as { readonly Bun?: unknown }).Bun !== "undefined"
const suite = underBun ? describe.skip : describe

interface Seen {
  method: string
  path: string
  headers: http.IncomingHttpHeaders
  body: string
}

let seen: Seen | undefined
let respond: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_req, res) => {
  res.writeHead(200)
  res.end("ok")
}

const server = http.createServer((req, res) => {
  let body = ""
  req.on("data", (chunk) => {
    body += chunk
  })
  req.on("end", () => {
    seen = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body }
    respond(req, res)
  })
})

let origin = ""
// Lazy: constructing one under Bun throws by design, and module scope runs even for a skipped suite.
let cached: ProxyTransport | undefined
const transport: ProxyTransport = (target, request) => {
  cached ??= undiciTransport()
  return cached(target, request)
}

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === "object")
  origin = `http://127.0.0.1:${address.port}`
})

after(() => {
  server.close()
})

const proxy = (options: Partial<Parameters<typeof createProxy>[0]> = {}) =>
  createProxy({ upstream: origin, transport, ...options })

suite("undiciTransport()", () => {
  test("forwards method, path, query and body; relays status and body back", async () => {
    respond = (_req, res) => {
      res.writeHead(201, { "content-type": "application/json" })
      res.end(JSON.stringify({ pong: true }))
    }
    const res = await proxy()(
      new Request("http://edge.test/v1/items?limit=2&q=a%20b", {
        method: "POST",
        body: JSON.stringify({ ping: true }),
        headers: { "content-type": "application/json" },
      }),
    )
    assert.equal(res.status, 201)
    assert.deepEqual(await res.json(), { pong: true })
    assert.equal(seen?.method, "POST")
    assert.equal(seen?.path, "/v1/items?limit=2&q=a%20b")
    assert.equal(seen?.body, JSON.stringify({ ping: true }))
  })

  test("strips hop-by-hop and Connection-nominated request headers", async () => {
    respond = (_req, res) => {
      res.writeHead(200)
      res.end("ok")
    }
    await proxy()(
      new Request("http://edge.test/x", {
        headers: {
          connection: "x-internal-token, keep-alive",
          "x-internal-token": "leak-me",
          te: "trailers",
          "proxy-authorization": "Basic abc",
          "x-app": "stays",
        },
      }),
    )
    assert.equal(seen?.headers["x-internal-token"], undefined)
    assert.equal(seen?.headers.te, undefined)
    assert.equal(seen?.headers["proxy-authorization"], undefined)
    assert.equal(seen?.headers["x-app"], "stays")
  })

  test("strips hop-by-hop and Connection-nominated response headers", async () => {
    respond = (_req, res) => {
      res.writeHead(200, {
        connection: "x-backend-secret",
        "x-backend-secret": "internal",
        "keep-alive": "timeout=5",
        "x-public": "stays",
      })
      res.end("ok")
    }
    const res = await proxy()(new Request("http://edge.test/x"))
    assert.equal(res.headers.get("x-backend-secret"), null)
    assert.equal(res.headers.get("keep-alive"), null)
    assert.equal(res.headers.get("connection"), null)
    assert.equal(res.headers.get("x-public"), "stays")
  })

  test("never follows upstream redirects", async () => {
    respond = (_req, res) => {
      res.writeHead(302, { location: "http://evil.example/next" })
      res.end()
    }
    const res = await proxy()(new Request("http://edge.test/x"))
    assert.equal(res.status, 302)
    assert.equal(res.headers.get("location"), "http://evil.example/next")
  })

  test("a protocol-relative path cannot change the upstream host", async () => {
    respond = (_req, res) => {
      res.writeHead(200)
      res.end("still-here")
    }
    const res = await proxy()(new Request("http://edge.test//evil.example/steal"))
    assert.equal(await res.text(), "still-here")
    assert.ok(seen?.path.endsWith("evil.example/steal"))
  })

  test("multiple Set-Cookie headers survive the relay", async () => {
    respond = (_req, res) => {
      res.writeHead(200, { "set-cookie": ["a=1; Path=/", "b=2; Path=/"] })
      res.end("ok")
    }
    const res = await proxy()(new Request("http://edge.test/x"))
    assert.deepEqual(res.headers.getSetCookie(), ["a=1; Path=/", "b=2; Path=/"])
  })

  test("forwarding metadata is stripped by default and appended on opt-in", async () => {
    respond = (_req, res) => {
      res.writeHead(200)
      res.end("ok")
    }
    const forged = { "x-forwarded-for": "1.2.3.4", forwarded: "for=1.2.3.4" }
    await proxy()(new Request("http://edge.test/x", { headers: forged }))
    assert.equal(seen?.headers["x-forwarded-for"], undefined)
    assert.equal(seen?.headers.forwarded, undefined)

    await proxy({
      forwardClientIp: true,
      trustForwardedFor: true,
      forwardedHost: "public.example",
    })({
      req: new Request("http://edge.test/x", { headers: { ...forged, host: "edge.test" } }),
      clientIp: "203.0.113.9",
    })
    assert.equal(seen?.headers["x-forwarded-for"], "1.2.3.4, 203.0.113.9")
    assert.equal(seen?.headers["x-forwarded-host"], "public.example")
  })

  test("static headers override after hygiene", async () => {
    respond = (_req, res) => {
      res.writeHead(200)
      res.end("ok")
    }
    await proxy({ headers: { "x-api-key": "k1" } })(
      new Request("http://edge.test/x", { headers: { "x-api-key": "client-supplied" } }),
    )
    assert.equal(seen?.headers["x-api-key"], "k1")
  })

  // `fetch` reports a null body for these; undici hands back a real stream, and passing one to
  // `new Response(..., { status: 204 })` throws. Left unhandled this is a flat 502 on every 204.
  test("bodiless statuses relay without a body", async () => {
    respond = (_req, res) => {
      res.writeHead(204)
      res.end()
    }
    const res = await proxy()(new Request("http://edge.test/x"))
    assert.equal(res.status, 204)
    assert.equal(res.body, null)
  })

  test("HEAD relays without a body", async () => {
    respond = (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" })
      res.end()
    }
    const res = await proxy()(new Request("http://edge.test/x", { method: "HEAD" }))
    assert.equal(res.status, 200)
    assert.equal(res.body, null)
  })

  test("streams an upstream body through without buffering it whole", async () => {
    respond = (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" })
      res.write("first,")
      setTimeout(() => res.end("second"), 10)
    }
    const res = await proxy()(new Request("http://edge.test/x"))
    assert.equal(await res.text(), "first,second")
  })

  test("unreachable upstream answers a flat 502", async () => {
    const res = await createProxy({ upstream: "http://127.0.0.1:1", transport })(
      new Request("http://edge.test/x"),
    )
    assert.equal(res.status, 502)
    assert.deepEqual(await res.json(), { ok: false, error: "bad_gateway" })
  })

  test("deadline answers a flat 504", async () => {
    respond = (_req, res) => {
      setTimeout(() => {
        res.writeHead(200)
        res.end("late")
      }, 400)
    }
    const res = await proxy({ timeoutMs: 40 })(new Request("http://edge.test/x"))
    assert.equal(res.status, 504)
    assert.deepEqual(await res.json(), { ok: false, error: "gateway_timeout" })
  })

  test("rejects a negative bodyTimeoutMs", () => {
    assert.throws(() => undiciTransport({ bodyTimeoutMs: -1 }), /bodyTimeoutMs/)
  })

  // With no `transport` given, `createProxy` must pick undici on Node (undici is installed here).
  // The proof is behavioural: undici does not decode `Content-Encoding`, so a compressed upstream
  // relays with its `content-encoding` and exact bytes intact. Under the old fetch default the
  // encoding was stripped and the body decoded, so this asserts the selection, not just that a proxy
  // works.
  test("the default transport on Node is undici: a compressed body relays with its encoding intact", async () => {
    const { gzipSync } = await import("node:zlib")
    const payload = JSON.stringify({ ok: true, pad: "x".repeat(200) })
    const gz = gzipSync(payload)
    respond = (_req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": String(gz.length),
      })
      res.end(gz)
    }
    // No `transport` - exercise the default selection path.
    const res = await createProxy({ upstream: origin })(new Request("http://edge.test/x"))
    assert.equal(res.status, 200)
    assert.equal(res.headers.get("content-encoding"), "gzip")
    assert.equal(res.headers.get("content-length"), String(gz.length))
    // The relayed bytes are the upstream's compressed bytes, unmodified.
    const bytes = Buffer.from(await res.arrayBuffer())
    assert.deepEqual(bytes, gz)
    // And they still decode to the original payload - a fetch-decoded relay would have thrown here.
    const { gunzipSync } = await import("node:zlib")
    assert.equal(gunzipSync(bytes).toString(), payload)
  })
})
