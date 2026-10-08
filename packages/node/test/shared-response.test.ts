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
