import { afterEach, describe, expect, test } from "bun:test"
import { server, silentLogger } from "@nifrajs/core"
import { type NodeServer, serve } from "../src/index.ts"

/**
 * The Node adapter's own writers, over a real socket: a Response a handler hands to many requests
 * never carries one request's cookie to the next, and a body that cannot be sent again is answered
 * with a clean internal error, not with the headers it was staged with.
 */

let running: NodeServer | undefined
afterEach(async () => {
  await running?.stop({ drainMs: 0 })
  running = undefined
})

const NODE_BODY = Symbol.for("nifra.response.body")

function app() {
  const empty = new Response(null, { status: 204, headers: { "x-own": "1" } })
  const redirect = new Response(null, { status: 302, headers: { location: "/home" } })
  const marked = new Response(null, { headers: { "content-type": "text/plain" } })
  Object.defineProperty(marked, NODE_BODY, { value: "marked-body" })
  const body = new Response("payload", { headers: { "content-type": "text/plain" } })
  const shared = { empty, redirect, marked, body }
  const routes = server({ logger: silentLogger })
  for (const [name, response] of Object.entries(shared)) {
    routes.get(`/${name}`, (c) => {
      if (c.header("x-user") === "alice") c.set.cookie("sid", "alice-session")
      return response
    })
  }
  routes.get("/locked", (c) => {
    c.set.cookie("sid", "alice-session")
    const locked = new Response("never sent", { headers: { "x-staged": "1" } })
    locked.body?.getReader()
    return locked
  })
  return { routes, shared }
}

const send = (path: string, user: string): Promise<Response> =>
  fetch(`http://127.0.0.1:${running?.port}${path}`, {
    headers: { "x-user": user },
    redirect: "manual",
  })

describe("@nifrajs/node: a Response returned to many requests", () => {
  for (const path of ["/empty", "/redirect", "/marked"]) {
    test(`${path}: alice's cookie never reaches bob, and the shared Response is untouched`, async () => {
      const { routes, shared } = app()
      running = await serve(routes, { hostname: "127.0.0.1", port: 0 })
      const alice = await send(path, "alice")
      const aliceBody = await alice.text()
      const bob = await send(path, "bob")
      expect(alice.headers.get("set-cookie")).toContain("sid=alice-session")
      expect(bob.status).toBe(alice.status)
      expect(bob.headers.getSetCookie()).toEqual([])
      expect(await bob.text()).toBe(aliceBody)
      expect(shared.empty.headers.has("set-cookie")).toBe(false)
      expect(shared.redirect.headers.has("set-cookie")).toBe(false)
      expect(shared.marked.headers.has("set-cookie")).toBe(false)
      if (path === "/marked") expect(aliceBody).toBe("marked-body")
    })
  }

  test("/body: a second send is an internal error without alice's cookie", async () => {
    const { routes } = app()
    running = await serve(routes, { hostname: "127.0.0.1", port: 0 })
    const alice = await send("/body", "alice")
    expect(await alice.text()).toBe("payload")
    const bob = await send("/body", "bob")
    expect(bob.status).toBe(500)
    expect(bob.headers.getSetCookie()).toEqual([])
    expect(await bob.json()).toEqual({ ok: false, error: "internal_error" })
  })

  test("a body that cannot be read is answered without the headers staged for it", async () => {
    const { routes } = app()
    running = await serve(routes, { hostname: "127.0.0.1", port: 0 })
    const res = await send("/locked", "alice")
    expect(res.status).toBe(500)
    expect(res.headers.getSetCookie()).toEqual([])
    expect(res.headers.get("x-staged")).toBeNull()
    await res.arrayBuffer()
  })
})

describe("@nifrajs/node: a handler-built Response carries the request's c.set headers", () => {
  function guarded() {
    const empty = new Response(null, { status: 204, headers: { "x-own": "1" } })
    const routes = server({ logger: silentLogger })
      .beforeHandle((c) => {
        if (c.req.headers.get("x-user") !== "alice") return undefined
        c.set.headers["cache-control"] = "no-store"
        c.set.headers["content-type"] = "application/json"
        c.set.headers["content-length"] = "999"
        return undefined
      })
      .get("/built", () => new Response("data", { headers: { "content-type": "text/plain" } }))
      .get("/own", () => new Response("data", { headers: { "cache-control": "max-age=60" } }))
      .get("/empty", () => empty)
      .get("/guarded", () => Response.redirect("http://x/home", 302))
    return { routes, empty }
  }

  test("merged, the Response's own win, body headers stay its own, and a shared one stays clean", async () => {
    const { routes, empty } = guarded()
    running = await serve(routes, { hostname: "127.0.0.1", port: 0 })
    const built = await send("/built", "alice")
    expect(built.headers.get("cache-control")).toBe("no-store")
    expect(built.headers.get("content-type")).toStartWith("text/plain")
    expect(await built.text()).toBe("data")
    expect((await send("/own", "alice")).headers.get("cache-control")).toBe("max-age=60")
    const guardedRedirect = await send("/guarded", "alice")
    expect(guardedRedirect.status).toBe(302)
    expect(guardedRedirect.headers.get("cache-control")).toBe("no-store")
    expect((await send("/empty", "alice")).headers.get("cache-control")).toBe("no-store")
    const bob = await send("/empty", "bob")
    expect(bob.headers.get("cache-control")).toBeNull()
    expect(bob.headers.get("x-own")).toBe("1")
    expect(empty.headers.has("cache-control")).toBe(false)
  })
})
