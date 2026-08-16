import { describe, expect, test } from "bun:test"
import { type Middleware, server, silentLogger } from "../src/index.ts"
import { responseObserver, withResponseObserver } from "../src/response-observer.ts"
import { taggedResponseBody } from "../src/server/respond.ts"

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
