import { describe, expect, test } from "bun:test"
import { type Middleware, server, silentLogger } from "../src/index.ts"
import { responseObserver, withResponseObserver } from "../src/response-observer.ts"
import { taggedResponseBody } from "../src/server/respond.ts"
import { RESPONSE_RESULT } from "../src/server/runtime-core.ts"

/** Return a copy of `res` with an `x-app` header - onResponse can't mutate in place. */
function tagged(res: Response, value: string): Response {
  const headers = new Headers(res.headers)
  headers.set("x-app", value)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

describe("onResponse", () => {
  test("runs on a successful response", async () => {
    const app = server()
      .onResponse((res) => tagged(res, "ok"))
      .get("/", () => "hi")
    const res = await app.fetch(new Request("http://x/"))
    expect(res.status).toBe(200)
    expect(res.headers.get("x-app")).toBe("ok")
    expect(await res.json()).toBe("hi")
  })

  test("runs on a 404", async () => {
    const app = server().onResponse((res) => tagged(res, "v"))
    const res = await app.fetch(new Request("http://x/missing"))
    expect(res.status).toBe(404)
    expect(res.headers.get("x-app")).toBe("v")
  })

  test("runs on a 500 error response", async () => {
    const app = server({ logger: silentLogger })
      .onResponse((res) => tagged(res, "v"))
      .get("/boom", () => {
        throw new Error("x")
      })
    const res = await app.fetch(new Request("http://x/boom"))
    expect(res.status).toBe(500)
    expect(res.headers.get("x-app")).toBe("v")
  })

  test("normalizes a body-bearing 304 before response hooks", async () => {
    const app = server().get(
      "/cached",
      () => new Response("stale", { status: 304, headers: { "content-length": "5" } }),
    )
    const res = await app.fetch(new Request("http://x/cached"))
    expect(res.status).toBe(304)
    expect(res.headers.get("content-length")).toBeNull()
    expect(await res.text()).toBe("")
  })

  test("runs on an onRequest short-circuit", async () => {
    const app = server()
      .onRequest(() => new Response("blocked", { status: 403 }))
      .onResponse((res) => tagged(res, "v"))
    const res = await app.fetch(new Request("http://x/anything"))
    expect(res.status).toBe(403)
    expect(res.headers.get("x-app")).toBe("v")
  })

  test("async + sync hooks run in registration order", async () => {
    const app = server()
      .onResponse(async (res) => tagged(res, `${res.headers.get("x-app") ?? ""}1`))
      .onResponse((res) => tagged(res, `${res.headers.get("x-app") ?? ""}2`))
      .get("/", () => "ok")
    const res = await app.fetch(new Request("http://x/"))
    expect(res.headers.get("x-app")).toBe("12")
  })

  test("a user-thrown TypeError in a header hook is not retried", async () => {
    let calls = 0
    const app = server()
      .use(responseObserver())
      .onResponseHeaders(() => {
        calls++
        throw new TypeError("user hook failure")
      })
      .get("/", () => "ok")

    await expect(app.fetch(new Request("http://x/"))).rejects.toThrow("user hook failure")
    expect(calls).toBe(1)
  })

  test("body tagging is isolated per app", async () => {
    const taggedApp = server()
      .use(responseObserver())
      .onResponseBody((body) => body)
      .get("/", () => ({ app: "tagged" }))
    const plainApp = server().get("/", () => ({ app: "plain" }))

    expect(taggedResponseBody(await taggedApp.fetch(new Request("http://x/")))).toBe(
      JSON.stringify({ app: "tagged" }),
    )
    expect(taggedResponseBody(await plainApp.fetch(new Request("http://x/")))).toBeUndefined()
  })

  test("preserves body hooks when routes are merged into another app", async () => {
    const group = server()
      .use(responseObserver())
      .onResponseBody((body) => `${body}!`)
      .get("/merged", () => ({ ok: true }))
    const app = server().merge(group)

    const res = await app.fetch(new Request("http://x/merged"))
    expect(await res.text()).toBe('{"ok":true}!')
  })

  test("does not treat another app's tagged response as a local framework body", async () => {
    const sourceApp = server()
      .use(responseObserver())
      .onResponseBody((body) => `${body}A`)
      .get("/", () => ({ source: true }))
    const foreignResponse = await sourceApp.fetch(new Request("http://x/"))
    const app = server()
      .use(responseObserver())
      .onResponseBody((body) => `${body}B`)
      .get("/", () => foreignResponse)

    const res = await app.fetch(new Request("http://x/"))
    expect(await res.text()).toBe('{"source":true}A')
  })

  test("body hooks take a c.text() body and a buffered page's, never a raw Response's", async () => {
    const page = {
      [RESPONSE_RESULT]: true as const,
      toResponse: () => new Response("<p>unseen</p>"),
      toNodeBody: () => ({
        status: 201,
        headers: { "content-type": "text/html; charset=utf-8", "x-page": ["a", "b"] },
        body: "<p>page</p>",
      }),
    }
    const seen: unknown[] = []
    const app = server()
      .use(responseObserver())
      .onResponseBody((body) => {
        seen.push(body)
        return `${body}!`
      })
      .get("/text", (c) => {
        c.set.headers["x-set"] = "1"
        return c.text("hello")
      })
      .get("/page", () => page)
      .get("/raw", () => new Response("raw"))
    const text = await app.fetch(new Request("http://x/text"))
    expect([text.headers.get("x-set"), await text.text()]).toEqual(["1", "hello!"])
    const built = await app.fetch(new Request("http://x/page"))
    expect([
      built.status,
      built.headers.get("content-type"),
      built.headers.get("x-page"),
      await built.text(),
    ]).toEqual([201, "text/html; charset=utf-8", "a, b", "<p>page</p>!"])
    expect(await (await app.fetch(new Request("http://x/raw"))).text()).toBe("raw")
    expect(seen).toEqual(["hello", "<p>page</p>"])
  })

  test("returns an untouched raw Response as-is", async () => {
    const direct = new Response("plain", {
      status: 202,
      headers: { "content-type": "text/plain", "x-direct": "1" },
    })
    const app = server().get("/raw", () => direct)
    const response = await app.fetch(new Request("http://x/raw"))

    expect(response).toBe(direct)
    expect(response.status).toBe(202)
    expect(response.headers.get("x-direct")).toBe("1")
    expect(await response.text()).toBe("plain")
  })

  test("does not treat a legacy unowned marker as a local framework body", async () => {
    const response = new Response('{"source":true}')
    Object.defineProperty(response, Symbol.for("nifra.response.body"), {
      value: '{"source":true}',
    })
    const app = server()
      .use(responseObserver())
      .onResponseBody((body) => `${body}B`)
      .get("/", () => response)

    expect(await (await app.fetch(new Request("http://x/"))).text()).toBe('{"source":true}')
  })

  test("onResponseFinalized observes the response after every transformation", async () => {
    let observedStatus: number | undefined
    const app = server()
      .onResponse(() => new Response("changed", { status: 202 }))
      .onResponseFinalized(({ response }) => {
        observedStatus = response.status
      })
      .get("/", () => "ok")

    const res = await app.fetch(new Request("http://x/"))
    expect(res.status).toBe(202)
    expect(observedStatus).toBe(202)
  })

  test("onResponseFinalized observers are ordered and fail-open", async () => {
    const order: string[] = []
    const app = server()
      .onResponseFinalized(async () => {
        order.push("first")
        throw new Error("observer failure")
      })
      .onResponseFinalized(() => {
        order.push("second")
      })
      .get("/", () => "ok")

    const res = await app.fetch(new Request("http://x/"))
    expect(res.status).toBe(200)
    expect(order).toEqual(["first", "second"])
  })
})

describe("use(middleware)", () => {
  test("wires every provided hook in lifecycle order", async () => {
    const order: string[] = []
    const mw: Middleware = {
      onRequest: () => {
        order.push("onRequest")
        return undefined
      },
      beforeHandle: () => {
        order.push("beforeHandle")
        return undefined
      },
      afterHandle: (result) => {
        order.push("afterHandle")
        return result
      },
      onResponse: (res) => {
        order.push("onResponse")
        return res
      },
      onError: () => {
        order.push("onError")
        return undefined
      },
    }
    const app = server()
      .use(mw)
      .get("/", () => "ok")
    const res = await app.fetch(new Request("http://x/"))
    expect(res.status).toBe(200)
    // onError is not invoked on the happy path.
    expect(order).toEqual(["onRequest", "beforeHandle", "afterHandle", "onResponse"])
  })

  test("a middleware's onError is wired (handles a thrown error)", async () => {
    const mw: Middleware = { onError: () => new Response("caught", { status: 418 }) }
    const app = server({ logger: silentLogger })
      .use(mw)
      .get("/boom", () => {
        throw new Error("x")
      })
    const res = await app.fetch(new Request("http://x/boom"))
    expect(res.status).toBe(418)
    expect(await res.text()).toBe("caught")
  })

  test("a partial middleware wires only what it provides", async () => {
    const app = server()
      .use({ onResponse: (res) => tagged(res, "partial") })
      .get("/", () => "ok")
    const res = await app.fetch(new Request("http://x/"))
    expect(res.headers.get("x-app")).toBe("partial")
  })

  // Queued cookies force the header init to a real `Headers` instead of the usual plain record, and
  // a registered body hook makes the response carry its serialized bytes. Together they select the
  // one JSON-building branch that has to add the content-type to a Headers it did not build.
  test("a body hook plus queued cookies still yields JSON with a content-type", async () => {
    const app = server()
      .use(responseObserver())
      .use(withResponseObserver<Middleware>({ onResponseBody: (body) => body }))
      .get("/", (c) => {
        c.set.cookie("sid", "abc")
        c.set.cookie("csrf", "xyz")
        return { ok: true }
      })
    const res = await app.fetch(new Request("http://x/"))

    expect(res.headers.get("content-type")).toContain("application/json")
    expect(res.headers.getSetCookie()).toHaveLength(2)
    expect(await res.json()).toEqual({ ok: true })
  })

  test("a body hook plus queued cookies preserves an explicit content-type", async () => {
    const app = server()
      .use(responseObserver())
      .use(withResponseObserver<Middleware>({ onResponseBody: (body) => body }))
      .get("/", (c) => {
        c.set.cookie("sid", "abc")
        c.set.headers["content-type"] = "application/vnd.api+json"
        return { ok: true }
      })
    const res = await app.fetch(new Request("http://x/"))
    expect(res.headers.get("content-type")).toBe("application/vnd.api+json")
  })
})

describe("c.json under a body hook", () => {
  test("a body hook gets the JSON text, with the status, status text and headers the call gave", async () => {
    const seen: unknown[] = []
    const app = server()
      .use(responseObserver())
      .onResponseBody((body) => {
        seen.push(body)
        return undefined
      })
      .get("/", (c) =>
        c.json({ n: 1 }, { status: 201, statusText: "Made", headers: { "x-a": "b" } }),
      )
      .get("/own", (c) =>
        c.json({ n: 2 }, { headers: { "content-type": "application/vnd.api+json" } }),
      )
    const res = await app.fetch(new Request("http://x/"))

    expect(seen).toEqual(['{"n":1}'])
    expect(res.status).toBe(201)
    expect(res.statusText).toBe("Made")
    expect(res.headers.get("x-a")).toBe("b")
    expect(res.headers.get("content-type")).toBe(Response.json(1).headers.get("content-type"))
    expect(await res.json()).toEqual({ n: 1 })

    const own = await app.fetch(new Request("http://x/own"))
    expect(own.headers.get("content-type")).toBe("application/vnd.api+json")
    expect(await own.text()).toBe('{"n":2}')
  })

  test("a Headers init is answered too, with the hook still run", async () => {
    const app = server()
      .use(responseObserver())
      .onResponseBody((body) => `${body}!`)
      .get("/", (c) => c.json({ ok: true }, { headers: new Headers({ "x-a": "b" }) }))
    const res = await app.fetch(new Request("http://x/"))
    expect(res.headers.get("x-a")).toBe("b")
    expect(res.headers.get("content-type")).toBe(Response.json(1).headers.get("content-type"))
    expect(await res.text()).toBe('{"ok":true}!')
  })

  test("a record naming a header in two casings keeps both values, as Response.json does", async () => {
    const headers = { "Set-Cookie": "sid=abc; Path=/", "set-cookie": "csrf=xyz; Path=/" }
    const app = server()
      .use(responseObserver())
      .onResponseBody((body) => body)
      .get("/", (c) => c.json({ ok: true }, { headers }))
    const res = await app.fetch(new Request("http://x/"))
    expect(res.headers.getSetCookie()).toEqual(
      Response.json({ ok: true }, { headers }).headers.getSetCookie(),
    )
    expect(res.headers.getSetCookie()).toHaveLength(2)
  })

  test("a one-shot iterator init is read once and its content-type kept", async () => {
    function* once(): Generator<[string, string]> {
      yield ["content-type", "application/vnd.api+json"]
      yield ["x-a", "b"]
    }
    // An iterable with no string keys: it types as a record, and `Headers` reads it as entries.
    let reads = 0
    const oneShot = {
      [Symbol.iterator]: () => {
        reads += 1
        return once()
      },
    }
    const app = server()
      .use(responseObserver())
      .onResponseBody((body) => body)
      .get("/", (c) => c.json({ ok: true }, { headers: oneShot }))
    const res = await app.fetch(new Request("http://x/"))
    expect(res.headers.get("content-type")).toBe("application/vnd.api+json")
    expect(res.headers.get("x-a")).toBe("b")
    expect(reads).toBe(1)
    expect(await res.text()).toBe('{"ok":true}')
  })

  test("an entries init that names a content-type keeps it", async () => {
    const app = server()
      .use(responseObserver())
      .onResponseBody((body) => body)
      .get("/", (c) =>
        c.json({ ok: true }, { headers: [["content-type", "application/x-custom"]] }),
      )
    const res = await app.fetch(new Request("http://x/"))
    expect(res.headers.get("content-type")).toBe("application/x-custom")
  })

  test("a hook replaces the body of a c.json reply", async () => {
    const app = server()
      .use(responseObserver())
      .onResponseBody((body) => `${body}!`)
      .get("/", (c) => c.json({ ok: true }))
    expect(await (await app.fetch(new Request("http://x/"))).text()).toBe('{"ok":true}!')
  })

  test("a value with no JSON form still throws, as Response.json does", async () => {
    const app = server({ logger: silentLogger })
      .use(responseObserver())
      .onResponseBody((body) => body)
      .get("/", (c) => c.json(undefined))
    const res = await app.fetch(new Request("http://x/"))
    expect(res.status).toBe(500)
  })

  test("without a body hook the reply stays the runtime's own", async () => {
    const app = server().get("/", (c) => c.json({ ok: true }))
    const res = await app.fetch(new Request("http://x/"))
    expect(taggedResponseBody(res)).toBeUndefined()
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe("render-time body hook", () => {
  const encoder = new TextEncoder()

  /** An observer whose body hook marks a reply `x-enc: one` and swaps its body, with a render
   * fast path that does the same work, and counters for how each ran. */
  function observer() {
    const calls = { render: 0, hook: 0 }
    const finish = (headers: { has(n: string): boolean; set(n: string, v: string): void }) =>
      headers.set("x-enc", "one")
    const middleware = withResponseObserver<Middleware>({
      onResponseBody(body, headers) {
        calls.hook++
        if (headers.has("x-enc")) return undefined
        finish(headers)
        return encoder.encode(`enc:${typeof body === "string" ? body : "bytes"}`)
      },
      renderBody(body, headers) {
        calls.render++
        finish(headers)
        return encoder.encode(`enc:${body}`)
      },
    })
    return { calls, middleware }
  }

  async function responsesBuilt(
    run: () => Response | Promise<Response>,
  ): Promise<[Response, number]> {
    const NativeResponse = globalThis.Response
    let built = 0
    class CountingResponse extends NativeResponse {
      constructor(body?: BodyInit | null, init?: ResponseInit) {
        built++
        super(body, init)
      }
    }
    globalThis.Response = CountingResponse
    try {
      return [await run(), built]
    } finally {
      globalThis.Response = NativeResponse
    }
  }

  test("a returned value is rendered through the fast path as one Response", async () => {
    const { calls, middleware } = observer()
    const app = server()
      .use(middleware)
      .get("/", () => ({ n: 1 }))
    const [res, built] = await responsesBuilt(() => app.fetch(new Request("http://x/")))

    expect(await res.text()).toBe('enc:{"n":1}')
    expect(res.headers.get("x-enc")).toBe("one")
    expect(res.headers.get("content-type")).toBe(Response.json(1).headers.get("content-type"))
    expect(calls.render).toBe(1)
    expect(built).toBe(1)
  })

  test("the body hook still runs on the rendered response and finds nothing to do", async () => {
    const { calls, middleware } = observer()
    const app = server()
      .use(middleware)
      .get("/", () => ({ n: 1 }))
    const res = await app.fetch(new Request("http://x/"))
    expect(calls.hook).toBe(1)
    expect(await res.text()).toBe('enc:{"n":1}')
  })

  test("the status a handler set is kept", async () => {
    const { middleware } = observer()
    const app = server()
      .use(middleware)
      .get("/", (c) => {
        c.set.status = 201
        return { n: 1 }
      })
    const res = await app.fetch(new Request("http://x/"))
    expect(res.status).toBe(201)
    expect(await res.text()).toBe('enc:{"n":1}')
  })

  test("a response hook registered first keeps the body hook where it was", async () => {
    const { calls, middleware } = observer()
    const app = server()
      .use(responseObserver())
      .onResponseHeaders((headers) => headers.set("x-first", "1"))
      .use(middleware)
      .get("/", () => ({ n: 1 }))
    const res = await app.fetch(new Request("http://x/"))
    expect(calls.render).toBe(0)
    expect(calls.hook).toBe(1)
    expect(res.headers.get("x-first")).toBe("1")
    expect(await res.text()).toBe('enc:{"n":1}')
  })

  test("a reply with c.set headers or cookies takes the body hook, not the fast path", async () => {
    const { calls, middleware } = observer()
    const app = server()
      .use(middleware)
      .get("/h", (c) => {
        c.set.headers["x-a"] = "b"
        return { n: 1 }
      })
    const res = await app.fetch(new Request("http://x/h"))
    expect(calls.render).toBe(0)
    expect(res.headers.get("x-a")).toBe("b")
    expect(await res.text()).toBe('enc:{"n":1}')
  })

  test("static response headers keep the body hook in charge", async () => {
    const { calls, middleware } = observer()
    const app = server()
      .responseHeaders({ "x-static": "1" })
      .use(middleware)
      .get("/", () => ({ n: 1 }))
    const res = await app.fetch(new Request("http://x/"))
    expect(calls.render).toBe(0)
    expect(res.headers.get("x-static")).toBe("1")
    expect(await res.text()).toBe('enc:{"n":1}')
  })

  test("a grouped hook offers the fast path only under its prefix", async () => {
    const { calls, middleware } = observer()
    const app = server()
      .group("/in", (g) => g.use(middleware).get("/", () => ({ n: 1 })))
      .get("/out", () => ({ n: 2 }))
    const inside = await app.fetch(new Request("http://x/in"))
    expect(await inside.text()).toBe('enc:{"n":1}')
    expect(calls.render).toBe(1)

    const outside = await app.fetch(new Request("http://x/out"))
    expect(await outside.text()).toBe('{"n":2}')
    expect(outside.headers.has("x-enc")).toBe(false)
  })

  test("a group behind another response hook does not take the fast path", async () => {
    const { calls, middleware } = observer()
    const app = server()
      .use(responseObserver())
      .onResponseHeaders((headers) => headers.set("x-first", "1"))
      .group("/in", (g) => g.use(middleware).get("/", () => ({ n: 1 })))
    const res = await app.fetch(new Request("http://x/in"))
    expect(calls.render).toBe(0)
    expect(await res.text()).toBe('enc:{"n":1}')
  })

  test("a fast path that changes nothing leaves the reply as the plain render builds it", async () => {
    const calls = { render: 0 }
    const app = server()
      .use(
        withResponseObserver<Middleware>({
          onResponseBody: () => undefined,
          renderBody() {
            calls.render++
            return undefined
          },
        }),
      )
      .get("/", () => ({ n: 1 }))
    const res = await app.fetch(new Request("http://x/"))
    expect(calls.render).toBe(1)
    expect(await res.json()).toEqual({ n: 1 })
    expect(res.headers.get("content-type")).toBe(Response.json(1).headers.get("content-type"))
  })

  test("the header view answers only the names the reply has", async () => {
    const seen: (string | null)[] = []
    const app = server()
      .use(
        withResponseObserver<Middleware>({
          onResponseBody: () => undefined,
          renderBody(_body, headers) {
            seen.push(headers.get("constructor"), headers.get("Content-Type"))
            return undefined
          },
        }),
      )
      .get("/", () => ({ n: 1 }))
    await app.fetch(new Request("http://x/"))
    expect(seen).toEqual([null, Response.json(1).headers.get("content-type")])
  })

  test("a fast path with no body hook is refused at registration", () => {
    expect(() =>
      server().use(withResponseObserver<Middleware>({ renderBody: () => undefined })),
    ).toThrow("renderBody() requires a paired onResponseBody() hook")
  })

  test("c.json keeps its own reply: the fast path is for returned values", async () => {
    const { calls, middleware } = observer()
    const app = server()
      .use(middleware)
      .get("/", (c) => c.json({ n: 1 }))
    const res = await app.fetch(new Request("http://x/"))
    expect(calls.render).toBe(0)
    expect(await res.text()).toBe('enc:{"n":1}')
  })
})
