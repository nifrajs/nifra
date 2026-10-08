import { describe, expect, test } from "bun:test"
import { type AnyServer, server, silentLogger, writableResponse } from "../src/index.ts"
import { nodeDirect } from "../src/node-direct.ts"
import { responseObserver } from "../src/response-observer.ts"
import { nodeOutcomeToResponse } from "../src/server/node-outcome.ts"

/**
 * A handler may hand the same `Response` object to many requests: a module-level `204`, a shared
 * redirect. Whatever one request adds to it (a session cookie, a header a hook derives from the
 * caller, the app's declared headers) must never reach another request, and the shared object stays
 * as its author built it. A body-bearing Response can be sent once, so sending it again is an
 * internal error that carries none of the first request's headers.
 */

type Send = (path: string, user: string) => Promise<Response>
interface Lane {
  readonly name: string
  open(app: AnyServer): { readonly send: Send; close(): Promise<void> }
}

const request = (base: string, path: string, user: string): Request =>
  new Request(`${base}${path}`, { headers: { "x-user": user }, redirect: "manual" })

const LANES: readonly Lane[] = [
  {
    name: "app.fetch",
    open: (app) => ({
      send: async (path, user) => app.fetch(request("http://t", path, user)),
      close: async () => {},
    }),
  },
  {
    name: "app.resolveNode",
    open: (app) => ({
      send: async (path, user) =>
        nodeOutcomeToResponse(await app.resolveNode(request("http://t", path, user))),
      close: async () => {},
    }),
  },
  {
    name: "Bun listen()",
    open: (app) => {
      const running = app.listen(0, { hostname: "127.0.0.1" })
      return {
        send: (path, user) => fetch(request(`http://127.0.0.1:${running.port}`, path, user)),
        close: () => app.stop(),
      }
    },
  },
]

function fixtures() {
  const empty = new Response(null, { status: 204 })
  const redirect = new Response(null, { status: 302, headers: { location: "/home" } })
  const swapped = new Response(null, { status: 202 })
  const body = new Response("payload", { headers: { "content-type": "text/plain" } })
  const login = (c: {
    header: (name: string) => unknown
    set: { cookie: (name: string, value: string) => unknown }
  }) => {
    const user = c.header("x-user")
    if (user === "alice") c.set.cookie("sid", "alice-session")
  }
  const app = server({ logger: silentLogger })
    .use(nodeDirect())
    .use(responseObserver())
    .responseHeaders({ "x-frame-options": "DENY" })
    .onResponse((res, req) => (new URL(req.url).pathname === "/swap" ? swapped : res))
    .onResponseHeaders((headers, req) => {
      headers.set("x-seen-user", req.header("x-user") ?? "none")
    })
    .onResponse((res, req) => {
      res.headers.set("x-hook-user", req.headers.get("x-user") ?? "none")
      return res
    })
    .get("/empty", (c) => {
      login(c)
      return empty
    })
    .get("/redirect", (c) => {
      login(c)
      return redirect
    })
    .get("/thrown", (c) => {
      login(c)
      throw redirect
    })
    .get("/swap", (c) => {
      login(c)
      return { ok: true }
    })
    .get("/body", (c) => {
      login(c)
      return body
    })
  return { app, empty, redirect, swapped, body }
}

const headersOf = (response: Response): Array<[string, string]> => [...response.headers]

for (const lane of LANES) {
  describe(`a Response returned to many requests - ${lane.name}`, () => {
    for (const path of ["/empty", "/redirect", "/thrown", "/swap"]) {
      test(`${path}: one request's cookie and hook headers never reach the next`, async () => {
        const f = fixtures()
        const { send, close } = lane.open(f.app)
        try {
          const alice = await send(path, "alice")
          const bob = await send(path, "bob")
          // `/swap`'s hook answers with its own shared Response, which replaces the render that
          // carried the cookie and the declared headers.
          const rendered = path === "/swap" ? 0 : 1
          expect(alice.headers.getSetCookie()).toHaveLength(rendered)
          expect(alice.headers.get("x-hook-user")).toBe("alice")
          expect(alice.headers.get("x-seen-user")).toBe("alice")
          expect(alice.headers.get("x-frame-options")).toBe(rendered ? "DENY" : null)
          expect(bob.status).toBe(alice.status)
          expect(bob.headers.getSetCookie()).toEqual([])
          expect(bob.headers.get("x-hook-user")).toBe("bob")
          expect(bob.headers.get("x-seen-user")).toBe("bob")
          expect(bob.headers.get("x-frame-options")).toBe(rendered ? "DENY" : null)
        } finally {
          await close()
        }
        expect(headersOf(f.empty)).toEqual([])
        expect(headersOf(f.redirect)).toEqual([["location", "/home"]])
        expect(headersOf(f.swapped)).toEqual([])
      })
    }

    test("a body sent once is an internal error the second time, with none of the first request's headers", async () => {
      const f = fixtures()
      const { send, close } = lane.open(f.app)
      try {
        const alice = await send("/body", "alice")
        expect(alice.status).toBe(200)
        expect(await alice.text()).toBe("payload")
        expect(alice.headers.get("set-cookie")).toContain("sid=alice-session")
        const bob = await send("/body", "bob")
        expect(bob.status).toBe(500)
        expect(await bob.json()).toEqual({ ok: false, error: "internal_error" })
        expect(bob.headers.getSetCookie()).toEqual([])
        expect(bob.headers.get("x-hook-user")).toBe("bob")
        expect(bob.headers.get("content-type")).toContain("application/json")
      } finally {
        await close()
      }
    })
  })
}

describe("a Response returned to many requests - no hooks", () => {
  test("Bun listen(): a route that only queues a cookie copies the shared Response", async () => {
    const empty = new Response(null, { status: 204, headers: { "x-own": "1" } })
    const app = server({ logger: silentLogger }).get("/empty", (c) => {
      if (c.header("x-user") === "alice") c.set.cookie("sid", "alice-session")
      return empty
    })
    const running = app.listen(0, { hostname: "127.0.0.1" })
    try {
      const base = `http://127.0.0.1:${running.port}`
      const alice = await fetch(request(base, "/empty", "alice"))
      const bob = await fetch(request(base, "/empty", "bob"))
      expect(alice.headers.get("set-cookie")).toContain("sid=alice-session")
      expect(alice.headers.get("x-own")).toBe("1")
      expect(bob.headers.getSetCookie()).toEqual([])
      expect(bob.headers.get("x-own")).toBe("1")
    } finally {
      await app.stop()
    }
    expect(headersOf(empty)).toEqual([["x-own", "1"]])
  })
})

/** `Headers` that reject every write, as `Response.redirect()` and a `fetch()` result carry on Node,
 * Deno and workerd (Bun leaves them writable, so the guard is modeled here). */
class GuardedHeaders extends Headers {
  override append(): void {
    throw new TypeError("immutable")
  }
  override set(): void {
    throw new TypeError("immutable")
  }
  override delete(): void {
    throw new TypeError("immutable")
  }
}

describe("writableResponse", () => {
  test("a body-less Response is always copied, so the original never takes a write", () => {
    const shared = new Response(null, {
      status: 304,
      statusText: "Not Modified",
      headers: { etag: '"a"' },
    })
    const own = writableResponse(shared)
    expect(own).not.toBe(shared)
    expect(own.status).toBe(304)
    expect(own.statusText).toBe("Not Modified")
    own.headers.set("set-cookie", "sid=1")
    expect(headersOf(shared)).toEqual([["etag", '"a"']])
    expect(writableResponse(own)).not.toBe(own)
  })

  test("Response.error() is returned as is: it cannot be rebuilt", () => {
    const error = Response.error()
    expect(writableResponse(error)).toBe(error)
  })

  test("a body-bearing Response with writable headers is written in place", () => {
    const response = new Response("x")
    expect(writableResponse(response)).toBe(response)
  })

  test("a body-bearing Response with guarded headers is copied around the same body", async () => {
    const response = new Response("guarded", { status: 201, headers: { "x-a": "1" } })
    Object.defineProperty(response, "headers", { value: new GuardedHeaders({ "x-a": "1" }) })
    const own = writableResponse(response)
    expect(own).not.toBe(response)
    own.headers.set("x-b", "2")
    expect(own.status).toBe(201)
    expect(own.headers.get("x-a")).toBe("1")
    expect(own.headers.get("x-b")).toBe("2")
    expect(await own.text()).toBe("guarded")
  })
})
