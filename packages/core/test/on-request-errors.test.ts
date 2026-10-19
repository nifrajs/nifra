import { afterEach, describe, expect, test } from "bun:test"
import { type Logger, type RunningServer, server, status } from "../src/index.ts"
import { nodeDirect } from "../src/node-direct.ts"
import type { NodeServeOutcome } from "../src/server.ts"
import { websocket } from "../src/ws.ts"

// An `onRequest` hook that throws or rejects fails the request the way a handler error does: every
// `onError` the app registered may answer, else the logged default 500. It never rejects `fetch`.

const recorder = (): { logger: Logger; errors: unknown[] } => {
  const errors: unknown[] = []
  const ignore = (): void => undefined
  return {
    logger: { debug: ignore, info: ignore, warn: ignore, error: (_m, f) => errors.push(f?.detail) },
    errors,
  }
}

const failing = {
  sync: () => {
    throw new Error("store down")
  },
  async: async () => {
    await Promise.resolve()
    throw new Error("store down")
  },
} as const

const get = (path = "/") => new Request(`http://x${path}`)

async function nodeShape(outcome: NodeServeOutcome): Promise<{ status: number; body: unknown }> {
  if (outcome.kind === "response") {
    return { status: outcome.response.status, body: await outcome.response.json() }
  }
  const raw = outcome.body
  return {
    status: outcome.status,
    body: JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw ?? undefined)),
  }
}

for (const mode of ["sync", "async"] as const) {
  describe(`a ${mode} onRequest failure`, () => {
    test("with no onError answers the logged default 500", async () => {
      const { logger, errors } = recorder()
      const app = server({ logger })
        .onRequest(failing[mode])
        .get("/", () => "ok")
      const res = await app.fetch(get())
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ ok: false, error: "internal_error" })
      expect(errors).toEqual(["store down"])
    })

    test("goes to onError, which sees the error and a route-less context", async () => {
      const { logger, errors } = recorder()
      const seen: { message: string; path: string; params: unknown }[] = []
      const app = server({ logger })
        .onError((error, c) => {
          seen.push({
            message: error instanceof Error ? error.message : String(error),
            path: new URL(c.req.url).pathname,
            params: c.params,
          })
          return new Response("handled", { status: 503 })
        })
        .onRequest(failing[mode])
        .get("/:id", () => "ok")
      const res = await app.fetch(get("/7"))
      expect(res.status).toBe(503)
      expect(await res.text()).toBe("handled")
      expect(seen).toEqual([{ message: "store down", path: "/7", params: {} }])
      expect(errors).toEqual([])
    })

    test("runs every onError in order, including one added after the last route", async () => {
      const order: string[] = []
      const app = server({ unusedScopedHooks: "off" })
        .onError(() => {
          order.push("first")
          return undefined
        })
        .onRequest(failing[mode])
        .get("/", () => "ok")
        .onError(async () => {
          order.push("late")
          return status(503, { error: "rate_limit_unavailable" })
        })
      const res = await app.fetch(get())
      expect(order).toEqual(["first", "late"])
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: "rate_limit_unavailable" })
    })

    test("falls back to the logged default 500 when no onError answers", async () => {
      const { logger, errors } = recorder()
      const app = server({ logger })
        .onError(() => undefined)
        .onRequest(failing[mode])
        .get("/", () => "ok")
      const res = await app.fetch(get())
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ ok: false, error: "internal_error" })
      expect(errors).toEqual(["store down"])
    })

    test("is a later hook's failure too, after an earlier hook went async", async () => {
      const app = server()
        .onError(() => new Response("handled", { status: 503 }))
        .onRequest(async () => undefined)
        .onRequest(failing[mode])
        .get("/", () => "ok")
      expect((await app.fetch(get())).status).toBe(503)
    })

    test("passes through onResponse, like any other answer", async () => {
      const app = server({ logger: recorder().logger })
        .onRequest(failing[mode])
        .onResponse((res) => {
          res.headers.set("x-seen", "1")
          return res
        })
        .responseHeaders({ "x-frame-options": "DENY" })
        .get("/", () => "ok")
      const res = await app.fetch(get())
      expect(res.status).toBe(500)
      expect(res.headers.get("x-seen")).toBe("1")
      expect(res.headers.get("x-frame-options")).toBe("DENY")
    })

    test("on the Node lane answers through onError, with and without a native twin", async () => {
      const handled = () => status(503, { error: "handled" })
      const plain = server({ logger: recorder().logger })
        .use(nodeDirect())
        .onError(handled)
        .onRequest(failing[mode])
        .get("/", () => "ok")
      const twinned = server({ logger: recorder().logger })
        .use(nodeDirect())
        .onError(handled)
        .use({ onRequest: () => undefined, onNodeRequest: failing[mode] })
        .get("/", () => "ok")
      const bare = server({ logger: recorder().logger })
        .use(nodeDirect())
        .use({ onRequest: () => undefined, onNodeRequest: failing[mode] })
        .get("/", () => "ok")
      for (const app of [plain, twinned]) {
        expect(await nodeShape(await app.resolveNode(get()))).toEqual({
          status: 503,
          body: { error: "handled" },
        })
      }
      expect(await nodeShape(await bare.resolveNode(get()))).toEqual({
        status: 500,
        body: { ok: false, error: "internal_error" },
      })
    })

    test("refuses a WebSocket handshake through onError", async () => {
      const app = server()
        .use(websocket())
        .onError(() => new Response("handled", { status: 503 }))
        .onRequest(failing[mode])
        .ws("/chat", { message() {} })
      const outcome = await app.resolveWebSocketUpgrade(
        new Request("http://x/chat", {
          headers: {
            upgrade: "websocket",
            connection: "Upgrade",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            "sec-websocket-version": "13",
          },
        }),
      )
      expect(outcome.kind).toBe("reject")
      if (outcome.kind !== "reject") return
      expect(outcome.response.status).toBe(503)
      expect(await outcome.response.text()).toBe("handled")
    })
  })
}

describe("a thrown answer from onRequest", () => {
  test("a thrown Response or status() is sent as if returned, with no onError", async () => {
    const { logger, errors } = recorder()
    let onErrorCalls = 0
    const app = server({ logger })
      .onError(() => {
        onErrorCalls++
        return undefined
      })
      .onRequest((req) => {
        if (req.url.endsWith("/response")) throw new Response("no", { status: 401 })
        throw status(429, { error: "slow_down" })
      })
      .get("/*", () => "ok")
    const thrown = await app.fetch(get("/response"))
    expect(thrown.status).toBe(401)
    expect(await thrown.text()).toBe("no")
    const result = await app.fetch(get("/status"))
    expect(result.status).toBe(429)
    expect(await result.json()).toEqual({ error: "slow_down" })
    expect(onErrorCalls).toBe(0)
    expect(errors).toEqual([])
  })

  test("onError reads the app's decorations", async () => {
    const app = server()
      .decorate("tag", "app")
      .onError((_error, c) => new Response(c.tag))
      .onRequest(failing.sync)
      .get("/", () => "ok")
    expect(await (await app.fetch(get())).text()).toBe("app")
  })
})

describe("over a Bun.serve socket", () => {
  let running: RunningServer | undefined
  afterEach(() => {
    running?.stop(true)
    running = undefined
  })

  test("the client gets the onError answer, not the runtime's bare 500", async () => {
    const app = server()
      .onError(() => new Response("handled", { status: 503 }))
      .onRequest(failing.async)
      .get("/", () => "ok")
    running = app.listen(0, { hostname: "127.0.0.1" })
    const res = await fetch(`http://127.0.0.1:${running.port}/`)
    expect(res.status).toBe(503)
    expect(await res.text()).toBe("handled")
  })
})
