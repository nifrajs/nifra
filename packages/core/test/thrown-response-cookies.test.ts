import { describe, expect, test } from "bun:test"
import { type AnyServer, server, silentLogger } from "../src/index.ts"
import { nodeDirect } from "../src/node-direct.ts"
import type { StandardSchemaV1, StandardTypes } from "../src/schema/standard.ts"
import { nodeOutcomeToResponse } from "../src/server/node-outcome.ts"

/**
 * A handler that queues a cookie and then THROWS a `Response` - the login handler or guard that sets
 * (or clears) a session cookie and throws a redirect - ships the cookie, exactly as the same
 * `Response` RETURNED does. `c.set.headers` and `c.set.status` stay out of it on both: a `Response`
 * is the app's own answer, and only cookies accumulate onto it.
 *
 * Every case runs on both serving lanes: `app.fetch` (Web) and `app.resolveNode` (Node-direct).
 */

const SID = "sid=abc; Path=/; HttpOnly; Secure; SameSite=Lax"

const passthrough: StandardSchemaV1<unknown, unknown> = {
  "~standard": {
    version: 1,
    vendor: "nifra-test",
    validate: (value) => ({ value }),
    types: undefined as unknown as StandardTypes<unknown, unknown>,
  },
}

const redirect = (): Response => new Response(null, { status: 303, headers: { location: "/home" } })

/** A `Response` whose `Headers` reject every write, as `Response.redirect()` and a `fetch()` result
 * do on Node, Deno and workerd (Bun leaves them writable, so the guard is modeled here). */
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
const guardedRedirect = (): Response => {
  const response = redirect()
  Object.defineProperty(response, "headers", {
    value: new GuardedHeaders({ location: "/home" }),
  })
  return response
}

type Lane = (app: AnyServer, request: Request) => Promise<Response>
const LANES: ReadonlyArray<readonly [string, Lane]> = [
  ["app.fetch", async (app, request) => app.fetch(request)],
  [
    "app.resolveNode",
    async (app, request) => nodeOutcomeToResponse(await app.resolveNode(request)),
  ],
]

const base = () => server({ logger: silentLogger }).use(nodeDirect())
const get = (path: string): Request => new Request(`http://t${path}`)
const post = (path: string): Request =>
  new Request(`http://t${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "ada" }),
  })

for (const [lane, send] of LANES) {
  describe(`a thrown Response carries the queued cookies - ${lane}`, () => {
    test("sync and async handlers", async () => {
      const app = base()
        .get("/sync", (c) => {
          c.set.cookie("sid", "abc")
          throw redirect()
        })
        .get("/async", async (c) => {
          await Promise.resolve()
          c.set.cookie("sid", "abc")
          throw redirect()
        })
      for (const path of ["/sync", "/async"]) {
        const res = await send(app, get(path))
        expect(res.status).toBe(303)
        expect(res.headers.get("location")).toBe("/home")
        expect(res.headers.getSetCookie()).toEqual([SID])
      }
    })

    test("matches the same Response returned, cookie for cookie", async () => {
      const app = base()
        .get("/thrown", (c) => {
          c.set.cookie("sid", "abc")
          c.set.deleteCookie("old")
          throw new Response("gone", { status: 404, headers: { "set-cookie": "own=1" } })
        })
        .get("/returned", (c) => {
          c.set.cookie("sid", "abc")
          c.set.deleteCookie("old")
          return new Response("gone", { status: 404, headers: { "set-cookie": "own=1" } })
        })
      const thrown = await send(app, get("/thrown"))
      const returned = await send(app, get("/returned"))
      expect(thrown.status).toBe(404)
      expect(thrown.headers.getSetCookie()).toEqual(returned.headers.getSetCookie())
      expect(thrown.headers.getSetCookie()).toHaveLength(3)
      expect(thrown.headers.getSetCookie()[0]).toBe("own=1")
      expect(await thrown.text()).toBe("gone")
    })

    test("c.set.headers and c.set.status are not applied to it", async () => {
      const app = base().get("/x", (c) => {
        c.set.status = 201
        c.set.headers["x-from-set"] = "1"
        c.set.cookie("sid", "abc")
        throw redirect()
      })
      const res = await send(app, get("/x"))
      expect(res.status).toBe(303)
      expect(res.headers.get("x-from-set")).toBeNull()
      expect(res.headers.getSetCookie()).toEqual([SID])
    })

    test("a guard that clears the session and throws a redirect", async () => {
      const app = base()
        .beforeHandle((c) => {
          c.set.deleteCookie("sid")
          throw redirect()
        })
        .get("/private", () => ({ secret: true }))
      const res = await send(app, get("/private"))
      expect(res.status).toBe(303)
      const cookies = res.headers.getSetCookie()
      expect(cookies).toHaveLength(1)
      expect(cookies[0]).toStartWith("sid=;")
    })

    test("derive, a lifecycle route, and a route with an onError hook", async () => {
      let errorHookRan = false
      const derived = base()
        .derive((c) => {
          c.set.cookie("sid", "abc")
          throw redirect()
        })
        .get("/derived", () => ({ ok: true }))
      const lifecycle = base()
        .derive(() => ({ user: "ada" }))
        .beforeHandle(() => undefined)
        .get("/lifecycle", (c) => {
          c.set.cookie("sid", "abc")
          throw redirect()
        })
      const hooked = base()
        .onError(() => {
          errorHookRan = true
          return undefined
        })
        .get("/hooked", (c) => {
          c.set.cookie("sid", "abc")
          throw redirect()
        })
      for (const [app, path] of [
        [derived, "/derived"],
        [lifecycle, "/lifecycle"],
        [hooked, "/hooked"],
      ] as const) {
        const res = await send(app, get(path))
        expect(res.status).toBe(303)
        expect(res.headers.getSetCookie()).toEqual([SID])
      }
      // Control flow, not a fault: the error hook never sees it.
      expect(errorHookRan).toBe(false)
    })

    test("body and query routes", async () => {
      const app = base()
        .post("/body", { body: passthrough }, (c) => {
          c.set.cookie("sid", "abc")
          throw redirect()
        })
        .post("/raw-body", async (c) => {
          await c.req.json()
          c.set.cookie("sid", "abc")
          throw redirect()
        })
        .get("/query", { query: passthrough }, (c) => {
          c.set.cookie("sid", "abc")
          throw redirect()
        })
      for (const request of [post("/body"), post("/raw-body"), get("/query?q=1")]) {
        const res = await send(app, request)
        expect(res.status).toBe(303)
        expect(res.headers.getSetCookie()).toEqual([SID])
      }
    })

    test("declared static response headers still fold in", async () => {
      const app = base()
        .responseHeaders({ "x-frame-options": "DENY" })
        .get("/x", (c) => {
          c.set.cookie("sid", "abc")
          throw redirect()
        })
      const res = await send(app, get("/x"))
      expect(res.status).toBe(303)
      expect(res.headers.get("x-frame-options")).toBe("DENY")
      expect(res.headers.getSetCookie()).toEqual([SID])
    })

    test("no cookie queued: the Response is sent as thrown", async () => {
      const app = base()
        .get("/ctx", (c) => {
          void c.params
          throw new Response("teapot", { status: 418, headers: { "x-own": "1" } })
        })
        .get("/no-ctx", () => {
          throw new Response("teapot", { status: 418, headers: { "x-own": "1" } })
        })
      for (const path of ["/ctx", "/no-ctx"]) {
        const res = await send(app, get(path))
        expect(res.status).toBe(418)
        expect(res.headers.get("x-own")).toBe("1")
        expect(res.headers.getSetCookie()).toEqual([])
        expect(await res.text()).toBe("teapot")
      }
    })

    test("a Response with write-guarded headers, thrown or returned", async () => {
      const app = base()
        .get("/thrown", (c) => {
          c.set.cookie("sid", "abc")
          throw guardedRedirect()
        })
        .get("/returned", (c) => {
          c.set.cookie("sid", "abc")
          return guardedRedirect()
        })
      for (const path of ["/thrown", "/returned"]) {
        const res = await send(app, get(path))
        expect(res.status).toBe(303)
        expect(res.headers.get("location")).toBe("/home")
        expect(res.headers.getSetCookie()).toEqual([SID])
      }
    })
  })
}
