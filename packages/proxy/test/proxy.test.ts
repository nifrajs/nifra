import { afterAll, describe, expect, test } from "bun:test"
import { createProxy } from "../src/index.ts"

interface Seen {
  method: string
  path: string
  headers: Record<string, string>
  body: string
}

let seen: Seen | undefined
let respond: (req: Request) => Response | Promise<Response> = () => new Response("ok")

const upstream = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    seen = {
      method: req.method,
      path: url.pathname + url.search,
      headers: Object.fromEntries(req.headers),
      body: await req.text(),
    }
    return respond(req)
  },
})
const ORIGIN = `http://127.0.0.1:${upstream.port}`

afterAll(() => upstream.stop(true))

describe("createProxy()", () => {
  test("rejects non-origin upstreams and bad options at construction", () => {
    expect(() => createProxy({ upstream: `${ORIGIN}/api` })).toThrow(/bare origin/)
    expect(() => createProxy({ upstream: `${ORIGIN}/?x=1` })).toThrow(/bare origin/)
    expect(() => createProxy({ upstream: `http://user:pw@host` })).toThrow(/bare origin/)
    expect(() => createProxy({ upstream: "ftp://host" })).toThrow(/http/)
    expect(() => createProxy({ upstream: ORIGIN, stripPrefix: "api/" })).toThrow(/stripPrefix/)
    expect(() => createProxy({ upstream: ORIGIN, timeoutMs: 0 })).toThrow(/timeoutMs/)
  })

  test("forwards method, path, query, and body; relays status and body back", async () => {
    const proxy = createProxy({ upstream: ORIGIN })
    respond = () => new Response(JSON.stringify({ pong: true }), { status: 201 })
    const res = await proxy(
      new Request("http://edge.test/v1/items?limit=2&q=a%20b", {
        method: "POST",
        body: JSON.stringify({ ping: true }),
        headers: { "content-type": "application/json" },
      }),
    )
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ pong: true })
    expect(seen?.method).toBe("POST")
    expect(seen?.path).toBe("/v1/items?limit=2&q=a%20b")
    expect(seen?.body).toBe(JSON.stringify({ ping: true }))
    expect(seen?.headers["content-type"]).toBe("application/json")
  })

  test("stripPrefix removes the mount prefix only", async () => {
    const proxy = createProxy({ upstream: ORIGIN, stripPrefix: "/api" })
    respond = () => new Response("ok")
    await proxy(new Request("http://edge.test/api/users?x=1"))
    expect(seen?.path).toBe("/users?x=1")
    await proxy(new Request("http://edge.test/api"))
    expect(seen?.path).toBe("/")
    await proxy(new Request("http://edge.test/other/thing"))
    expect(seen?.path).toBe("/other/thing")
  })

  // The prefix is a path segment, not a string prefix. Matching it as a substring rewrote sibling
  // routes that merely start with the same characters - `/apidocs` was forwarded as `docs`.
  test("stripPrefix matches whole segments, not a leading substring", async () => {
    const proxy = createProxy({ upstream: ORIGIN, stripPrefix: "/api" })
    respond = () => new Response("ok")
    await proxy(new Request("http://edge.test/apidocs/intro"))
    expect(seen?.path).toBe("/apidocs/intro")
    await proxy(new Request("http://edge.test/api-v2/users"))
    expect(seen?.path).toBe("/api-v2/users")
  })

  test("a protocol-relative path cannot change the upstream host", async () => {
    const proxy = createProxy({ upstream: ORIGIN })
    respond = () => new Response("still-here")
    const res = await proxy(new Request("http://edge.test//evil.example/steal"))
    expect(await res.text()).toBe("still-here")
    expect(seen?.headers.host).toBe(`127.0.0.1:${upstream.port}`)
    expect(seen?.path.endsWith("evil.example/steal")).toBe(true)
  })

  test("strips hop-by-hop and Connection-nominated request headers (CVE-2026-33805 / CVE-2026-71849 class)", async () => {
    const proxy = createProxy({ upstream: ORIGIN })
    respond = () => new Response("ok")
    await proxy(
      new Request("http://edge.test/x", {
        headers: {
          connection: "x-internal-token, keep-alive",
          "x-internal-token": "leak-me",
          te: "trailers",
          "proxy-authorization": "Basic abc",
          upgrade: "websocket",
          "x-app": "stays",
        },
      }),
    )
    expect(seen?.headers["x-internal-token"]).toBeUndefined()
    expect(seen?.headers.connection).not.toContain("x-internal-token")
    expect(seen?.headers.te).toBeUndefined()
    expect(seen?.headers["proxy-authorization"]).toBeUndefined()
    expect(seen?.headers.upgrade).toBeUndefined()
    expect(seen?.headers["x-app"]).toBe("stays")
  })

  test("strips hop-by-hop and Connection-nominated response headers", async () => {
    const proxy = createProxy({ upstream: ORIGIN })
    respond = () =>
      new Response("ok", {
        headers: {
          connection: "x-backend-secret",
          "x-backend-secret": "internal",
          "keep-alive": "timeout=5",
          "transfer-encoding": "chunked",
          "x-public": "stays",
        },
      })
    const res = await proxy(new Request("http://edge.test/x"))
    expect(res.headers.get("x-backend-secret")).toBeNull()
    expect(res.headers.get("keep-alive")).toBeNull()
    expect(res.headers.get("connection")).toBeNull()
    expect(res.headers.get("x-public")).toBe("stays")
  })

  test("forwarding metadata is stripped by default, appended truthfully on opt-in", async () => {
    respond = () => new Response("ok")
    const forged = {
      "x-forwarded-for": "1.2.3.4",
      "x-forwarded-host": "admin.internal",
      forwarded: "for=1.2.3.4",
    }
    await createProxy({ upstream: ORIGIN })(new Request("http://edge.test/x", { headers: forged }))
    expect(seen?.headers["x-forwarded-for"]).toBeUndefined()
    expect(seen?.headers["x-forwarded-host"]).toBeUndefined()
    expect(seen?.headers.forwarded).toBeUndefined()

    await createProxy({ upstream: ORIGIN, forwardClientIp: true })({
      req: new Request("http://edge.test/x", {
        headers: { ...forged, host: "edge.test" },
      }),
      clientIp: "203.0.113.9",
    })
    expect(seen?.headers["x-forwarded-for"]).toBe("1.2.3.4, 203.0.113.9")
    expect(seen?.headers["x-forwarded-proto"]).toBe("http")
    expect(seen?.headers["x-forwarded-host"]).toBe("edge.test")

    await createProxy({ upstream: ORIGIN, forwardClientIp: true })(
      new Request("http://edge.test/x", { headers: forged }),
    )
    expect(seen?.headers["x-forwarded-for"]).toBeUndefined()
    expect(seen?.headers["x-forwarded-host"]).toBeUndefined()
  })

  test("static headers override after hygiene", async () => {
    respond = () => new Response("ok")
    await createProxy({ upstream: ORIGIN, headers: { "x-api-key": "k1" } })(
      new Request("http://edge.test/x", { headers: { "x-api-key": "client-supplied" } }),
    )
    expect(seen?.headers["x-api-key"]).toBe("k1")
  })

  test("rejects static hop-by-hop and forwarding headers at construction", () => {
    expect(() => createProxy({ upstream: ORIGIN, headers: { connection: "keep-alive" } })).toThrow(
      /connection/,
    )
    expect(() =>
      createProxy({ upstream: ORIGIN, headers: { "x-forwarded-for": "1.2.3.4" } }),
    ).toThrow(/x-forwarded-for/)
  })

  test("never follows upstream redirects", async () => {
    const proxy = createProxy({ upstream: ORIGIN })
    respond = () =>
      new Response(null, { status: 302, headers: { location: "http://evil.example/next" } })
    const res = await proxy(new Request("http://edge.test/x"))
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("http://evil.example/next")
  })

  test("multiple Set-Cookie headers survive the relay", async () => {
    const proxy = createProxy({ upstream: ORIGIN })
    respond = () => {
      const headers = new Headers()
      headers.append("set-cookie", "a=1; Path=/")
      headers.append("set-cookie", "b=2; Path=/")
      return new Response("ok", { headers })
    }
    const res = await proxy(new Request("http://edge.test/x"))
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"])
  })

  test("unreachable upstream answers a flat 502", async () => {
    const proxy = createProxy({ upstream: "http://127.0.0.1:1" })
    const res = await proxy(new Request("http://edge.test/x"))
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ ok: false, error: "bad_gateway" })
  })

  test("deadline answers a flat 504", async () => {
    const proxy = createProxy({ upstream: ORIGIN, timeoutMs: 40 })
    respond = async () => {
      await new Promise((resolve) => setTimeout(resolve, 400))
      return new Response("late")
    }
    const res = await proxy(new Request("http://edge.test/x"))
    expect(res.status).toBe(504)
    expect(await res.json()).toEqual({ ok: false, error: "gateway_timeout" })
    respond = () => new Response("ok")
  })

  test("streams an upstream body through without buffering the whole payload", async () => {
    const proxy = createProxy({ upstream: ORIGIN })
    respond = () => {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode("first,"))
          await new Promise((resolve) => setTimeout(resolve, 10))
          controller.enqueue(new TextEncoder().encode("second"))
          controller.close()
        },
      })
      return new Response(stream, { headers: { "content-type": "text/plain" } })
    }
    const res = await proxy(new Request("http://edge.test/x"))
    expect(await res.text()).toBe("first,second")
  })

  // The seam hands over ALREADY-sanitised headers. If hygiene ran after the transport instead, a
  // custom transport would see the caller's Connection-nominated leak - so assert the order here,
  // not just the outcome.
  test("a custom transport receives sanitised headers and its response is relayed", async () => {
    let sawHeaders: Headers | undefined
    let sawTarget: URL | undefined
    const proxy = createProxy({
      upstream: ORIGIN,
      headers: { "x-api-key": "k1" },
      transport: async (target, request) => {
        sawTarget = target
        sawHeaders = request.headers
        return {
          status: 203,
          statusText: "",
          headers: new Headers({ "x-from": "custom", connection: "x-leak", "x-leak": "no" }),
          body: new Response("relayed").body,
        }
      },
    })
    const res = await proxy(
      new Request("http://edge.test/v1/x?a=1", {
        headers: { connection: "x-internal", "x-internal": "leak-me", "x-app": "stays" },
      }),
    )
    expect(sawTarget?.origin).toBe(ORIGIN)
    expect(sawTarget?.pathname + (sawTarget?.search ?? "")).toBe("/v1/x?a=1")
    expect(sawHeaders?.get("x-internal")).toBeNull()
    expect(sawHeaders?.get("host")).toBeNull()
    expect(sawHeaders?.get("x-app")).toBe("stays")
    expect(sawHeaders?.get("x-api-key")).toBe("k1")
    // Response hygiene still runs on whatever the transport returns.
    expect(res.status).toBe(203)
    expect(res.headers.get("x-from")).toBe("custom")
    expect(res.headers.get("x-leak")).toBeNull()
    expect(await res.text()).toBe("relayed")
  })

  test("undiciTransport() refuses to construct under Bun", async () => {
    const { undiciTransport } = await import("../src/undici.ts")
    expect(() => undiciTransport()).toThrow(/Node remedy/)
  })

  test("works mounted in a nifra app via mountFetch", async () => {
    const { server } = await import("@nifrajs/core")
    const proxy = createProxy({ upstream: ORIGIN })
    respond = () =>
      new Response(JSON.stringify({ from: "upstream" }), {
        headers: { "content-type": "application/json" },
      })
    const app = server().mountFetch("/api", proxy, { stripPrefix: true })
    const res = await app.fetch(new Request("http://edge.test/api/users"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ from: "upstream" })
    expect(seen?.path).toBe("/users")
  })
})
