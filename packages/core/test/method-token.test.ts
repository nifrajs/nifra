import { describe, expect, test } from "bun:test"
import { server } from "../src/index.ts"
import { nodeDirect } from "../src/node-direct.ts"
import { isRoutableMethod } from "../src/server/http.ts"
import { websocket } from "../src/ws.ts"

// A runtime's `Request` constructor normalizes or rejects an unusual method, so it cannot stand in
// for a transport that delivers the token as sent. Shadowing the accessor reproduces what such a
// transport hands the server.
function requestWith(method: string, url: string, init?: RequestInit): Request {
  const request = new Request(url, init)
  Object.defineProperty(request, "method", { value: method })
  return request
}

const VARIANTS = ["post", "Post", "pOST", "POST ", "PO_ST", "9POST", `P${"O".repeat(32)}`, ""]

describe("isRoutableMethod", () => {
  test("accepts uppercase tokens of letters, digits and hyphens, letter first, up to 32 chars", () => {
    for (const method of ["GET", "POST", "PATCH", "QUERY", "M-SEARCH", "VERSION-CONTROL", "X2"]) {
      expect(isRoutableMethod(method)).toBe(true)
    }
    expect(isRoutableMethod("A".repeat(32))).toBe(true)
  })

  test("refuses every other token", () => {
    for (const method of [...VARIANTS, "get", "-GET", "GÉT", "GET\n", "A".repeat(33)]) {
      expect(isRoutableMethod(method)).toBe(false)
    }
  })
})

describe("a request whose method token no route can be registered under", () => {
  test("never runs a handler and answers from the route table", async () => {
    const ran: string[] = []
    const app = server()
      .post("/mutate", (c) => {
        ran.push(c.req.method)
        return { ok: true }
      })
      .patch("/mutate/:id", (c) => {
        ran.push(c.req.method)
        return { ok: true }
      })

    for (const method of VARIANTS) {
      const onRoute = await app.fetch(requestWith(method, "http://t/mutate"))
      expect(onRoute.status).toBe(405)
      expect(onRoute.headers.get("allow")).toBe("POST")
      // Repeated so the dynamic match cache is exercised as well as the first walk.
      for (let i = 0; i < 3; i++) {
        const onParam = await app.fetch(requestWith(method, "http://t/mutate/7"))
        expect(onParam.status).toBe(405)
        expect(onParam.headers.get("allow")).toBe("PATCH")
      }
      expect((await app.fetch(requestWith(method, "http://t/absent"))).status).toBe(404)
    }
    expect(ran).toEqual([])

    expect((await app.fetch(new Request("http://t/mutate", { method: "POST" }))).status).toBe(200)
    expect(ran).toEqual(["POST"])
  })

  test("is not shown to an onRequest hook", async () => {
    const hookSaw: string[] = []
    const app = server()
      .onRequest((request) => {
        hookSaw.push(request.method)
        // A guard written the usual way: it only inspects the methods it was told to protect.
        if (request.method === "POST" && request.headers.get("x-token") !== "ok") {
          return Response.json({ ok: false }, { status: 403 })
        }
        return undefined
      })
      .post("/mutate", () => ({ ok: true }))

    for (const method of VARIANTS) {
      const response = await app.fetch(requestWith(method, "http://t/mutate"))
      expect(response.status).toBe(405)
      expect(response.headers.get("allow")).toBe("POST")
    }
    expect(hookSaw).toEqual([])

    expect((await app.fetch(new Request("http://t/mutate", { method: "POST" }))).status).toBe(403)
    const allowed = await app.fetch(
      new Request("http://t/mutate", { method: "POST", headers: { "x-token": "ok" } }),
    )
    expect(allowed.status).toBe(200)
    expect(hookSaw).toEqual(["POST", "POST"])
  })

  test("is not shown to an async onRequest hook", async () => {
    const hookSaw: string[] = []
    const app = server()
      .onRequest(async (request) => {
        await Promise.resolve()
        hookSaw.push(request.method)
        return undefined
      })
      .post("/mutate", () => ({ ok: true }))

    expect((await app.fetch(requestWith("post", "http://t/mutate"))).status).toBe(405)
    expect(hookSaw).toEqual([])
  })

  test("is not handed to a mounted handler, before or behind the route table", async () => {
    const mountSaw: string[] = []
    const record = (label: string) => (request: Request) => {
      mountSaw.push(`${label}:${request.method}`)
      return Response.json({ label })
    }
    const app = server()
      .mount({ path: "/api", app: { fetch: record("composed") } })
      .mountFetch("/legacy", record("legacy"))
      .post("/legacy/typed", () => ({ ok: true }))

    for (const method of VARIANTS) {
      expect((await app.fetch(requestWith(method, "http://t/api/items"))).status).toBe(404)
      expect((await app.fetch(requestWith(method, "http://t/legacy/items"))).status).toBe(404)
      const typed = await app.fetch(requestWith(method, "http://t/legacy/typed"))
      expect(typed.status).toBe(405)
      expect(typed.headers.get("allow")).toBe("POST")
    }
    expect(mountSaw).toEqual([])

    // A well-formed token the route table does not know still reaches the mount, as before.
    expect((await app.fetch(requestWith("PROPFIND", "http://t/api/items"))).status).toBe(200)
    expect((await app.fetch(requestWith("PROPFIND", "http://t/legacy/items"))).status).toBe(200)
    expect((await app.fetch(new Request("http://t/legacy/typed"))).status).toBe(200)
    expect(mountSaw).toEqual(["composed:PROPFIND", "legacy:PROPFIND", "legacy:GET"])
  })

  test("is not treated as a WebSocket handshake", async () => {
    const hookSaw: string[] = []
    let guardRan = 0
    const app = server()
      .onRequest((request) => {
        hookSaw.push(request.method)
        return undefined
      })
      .use(websocket())
      .ws("/socket", {
        upgrade: () => {
          guardRan += 1
          return {}
        },
      })

    for (const method of ["get", "Get", "gET"]) {
      const outcome = await app.resolveWebSocketUpgrade(
        requestWith(method, "http://t/socket", { headers: { upgrade: "websocket" } }),
      )
      expect(outcome.kind).toBe("pass")
    }
    expect(hookSaw).toEqual([])
    expect(guardRan).toBe(0)

    const handshake = await app.resolveWebSocketUpgrade(
      new Request("http://t/socket", { headers: { upgrade: "websocket" } }),
    )
    expect(handshake.kind).toBe("upgrade")
    expect(hookSaw).toEqual(["GET"])
    expect(guardRan).toBe(1)
  })

  test("takes the same path through the plain-data lane", async () => {
    const hookSaw: string[] = []
    const app = server()
      .use(nodeDirect())
      .onRequest((request) => {
        hookSaw.push(request.method)
        return undefined
      })
      .post("/mutate", () => ({ ok: true }))

    const outcome = await app.resolveNode(requestWith("post", "http://t/mutate"))
    if (outcome.kind !== "json") throw new Error(`expected a plain render, got ${outcome.kind}`)
    expect(outcome.status).toBe(405)
    expect(outcome.headers).toEqual({ allow: "POST" })
    expect(hookSaw).toEqual([])
  })
})
