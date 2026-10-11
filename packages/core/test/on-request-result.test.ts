import { describe, expect, test } from "bun:test"
import { server, status } from "../src/index.ts"
import { nodeDirect } from "../src/node-direct.ts"
import type { NodeServeOutcome } from "../src/server.ts"
import { websocket } from "../src/ws.ts"

// An `onRequest` hook refuses with the same `status()` value a route returns, and the refusal takes
// the normal response path: serialized body, content-type, declared headers, `onResponse`.

const refusal = () => status(401, { error: "key required" })

const app = () =>
  server()
    .responseHeaders({ "x-frame-options": "DENY" })
    .onRequest((req) => (req.headers.get("x-key") === null ? refusal() : undefined))
    .onResponse((res) => {
      res.headers.set("x-seen", "1")
      return res
    })
    .get("/data", () => ({ ok: true }))

const routeLevel = () =>
  server()
    .responseHeaders({ "x-frame-options": "DENY" })
    .onResponse((res) => {
      res.headers.set("x-seen", "1")
      return res
    })
    .get("/data", () => refusal())

async function shape(res: Response) {
  return {
    status: res.status,
    type: res.headers.get("content-type"),
    frame: res.headers.get("x-frame-options"),
    seen: res.headers.get("x-seen"),
    body: await res.json(),
  }
}

async function nodeShape(outcome: NodeServeOutcome) {
  if (outcome.kind === "response") return shape(outcome.response)
  const header = (name: string) => {
    const value = outcome.headers?.[name]
    return value === undefined ? null : String(value)
  }
  return {
    status: outcome.status,
    type: header("content-type"),
    frame: header("x-frame-options"),
    seen: header("x-seen"),
    body: JSON.parse(
      typeof outcome.body === "string"
        ? outcome.body
        : new TextDecoder().decode(outcome.body ?? undefined),
    ),
  }
}

describe("onRequest returning status()", () => {
  test("answers like the same value returned from a route", async () => {
    const expected = await shape(await routeLevel().fetch(new Request("http://x/data")))
    expect(expected).toMatchObject({ status: 401, frame: "DENY", seen: "1" })
    expect(await shape(await app().fetch(new Request("http://x/data")))).toEqual(expected)
    expect(await shape(await app().fetch(new Request("http://x/missing")))).toEqual(expected)
    const through = await app().fetch(new Request("http://x/data", { headers: { "x-key": "k" } }))
    expect(await through.json()).toEqual({ ok: true })
  })

  test("an async hook's refusal takes the same path", async () => {
    const asyncApp = server()
      .responseHeaders({ "x-frame-options": "DENY" })
      .onRequest(async () => refusal())
      .get("/data", () => ({ ok: true }))
    const res = await asyncApp.fetch(new Request("http://x/data"))
    expect(res.status).toBe(401)
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8")
    expect(res.headers.get("x-frame-options")).toBe("DENY")
    expect(await res.json()).toEqual({ error: "key required" })
  })

  test("the Node lane answers the same", async () => {
    const resolve = (target: ReturnType<typeof app>) =>
      target.use(nodeDirect()).resolveNode(new Request("http://x/data"))
    const expected = await nodeShape(await resolve(routeLevel()))
    expect(expected).toMatchObject({ status: 401, frame: "DENY", seen: "1" })
    expect(await nodeShape(await resolve(app()))).toEqual(expected)
  })

  test("a real Bun listen() answers the same", async () => {
    const running = app()
    const listening = running.listen(0, { hostname: "127.0.0.1" })
    try {
      const res = await fetch(`http://127.0.0.1:${listening.port}/data`)
      expect(await shape(res)).toEqual({
        status: 401,
        type: "application/json;charset=utf-8",
        frame: "DENY",
        seen: "1",
        body: { error: "key required" },
      })
    } finally {
      await running.stop()
    }
  })

  test("refuses a WebSocket handshake with the same status and body", async () => {
    const sockets = server()
      .onRequest(() => refusal())
      .use(websocket())
      .ws("/socket", { upgrade: () => ({}) })
    const outcome = await sockets.resolveWebSocketUpgrade(
      new Request("http://x/socket", { headers: { upgrade: "websocket" } }),
    )
    if (outcome.kind !== "reject") throw new Error(`expected a refusal, got ${outcome.kind}`)
    expect(outcome.response.status).toBe(401)
    expect(await outcome.response.json()).toEqual({ error: "key required" })
  })
})
