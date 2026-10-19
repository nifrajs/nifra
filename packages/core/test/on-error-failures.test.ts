import { describe, expect, test } from "bun:test"
import * as z from "zod"
import { type Logger, server, status } from "../src/index.ts"
import { nodeDirect } from "../src/node-direct.ts"
import { responseContract } from "../src/server/response-contract-lane.ts"
import type { NodeServeOutcome } from "../src/server.ts"
import { websocket } from "../src/ws.ts"

// An `onError` hook that throws or rejects never rejects `fetch` and never re-enters `onError`: the
// original error and the hook's own are both logged, and the stage's fail-closed answer is sent.

const recorder = (): { logger: Logger; errors: unknown[] } => {
  const errors: unknown[] = []
  const ignore = (): void => undefined
  return {
    logger: { debug: ignore, info: ignore, warn: ignore, error: (_m, f) => errors.push(f?.detail) },
    errors,
  }
}

const failingHook = {
  sync: () => {
    throw new Error("hook broke")
  },
  async: async () => {
    await Promise.resolve()
    throw new Error("hook broke")
  },
} as const

const get = (path = "/") => new Request(`http://x${path}`)
const INTERNAL = { ok: false, error: "internal_error" }

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

const upgrade = (path: string) =>
  new Request(`http://x${path}`, {
    headers: {
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
    },
  })

for (const mode of ["sync", "async"] as const) {
  describe(`a ${mode} onError failure`, () => {
    test("after a route error answers the logged default 500 and skips later hooks", async () => {
      const { logger, errors } = recorder()
      let laterCalls = 0
      const app = server({ logger, unusedScopedHooks: "off" })
        .onError(failingHook[mode])
        .onError(() => {
          laterCalls++
          return new Response("later")
        })
        .get("/", () => {
          throw new Error("handler broke")
        })
      const res = await app.fetch(get())
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual(INTERNAL)
      expect(errors).toEqual(["handler broke", "hook broke"])
      expect(laterCalls).toBe(0)
    })

    test("after an onRequest error answers the logged default 500", async () => {
      const { logger, errors } = recorder()
      const app = server({ logger })
        .onError(failingHook[mode])
        .onRequest(() => {
          throw new Error("store down")
        })
        .get("/", () => "ok")
      const res = await app.fetch(get())
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual(INTERNAL)
      expect(errors).toEqual(["store down", "hook broke"])
    })

    test("on the Node lane answers 500 for a route and an onRequest error", async () => {
      const { logger, errors } = recorder()
      const route = server({ logger })
        .use(nodeDirect())
        .onError(failingHook[mode])
        .get("/", () => {
          throw new Error("handler broke")
        })
      const hooked = server({ logger })
        .use(nodeDirect())
        .onError(failingHook[mode])
        .onRequest(() => {
          throw new Error("store down")
        })
        .get("/", () => "ok")
      const twinned = server({ logger })
        .use(nodeDirect())
        .onError(failingHook[mode])
        .use({
          onRequest: () => undefined,
          onNodeRequest: () => {
            throw new Error("store down")
          },
        })
        .get("/", () => "ok")
      for (const app of [route, hooked, twinned]) {
        expect(await nodeShape(await app.resolveNode(get()))).toEqual({
          status: 500,
          body: INTERNAL,
        })
      }
      expect(errors).toEqual([
        "handler broke",
        "hook broke",
        "store down",
        "hook broke",
        "store down",
        "hook broke",
      ])
    })

    test("keeps a failed authentication stage's 503", async () => {
      const { logger, errors } = recorder()
      const app = server({ logger })
        .onError(failingHook[mode])
        .authenticate({
          id: "provider",
          run: () => {
            throw new Error("provider down")
          },
        })
        .get("/private", () => ({ ok: true }))
      expect((await app.fetch(get("/private"))).status).toBe(503)
      expect(errors).toEqual(["provider down", "hook broke"])
    })

    test("refuses a WebSocket handshake with the logged 500", async () => {
      const { logger, errors } = recorder()
      const failedUpgrade = server({ logger })
        .use(websocket())
        .onError(failingHook[mode])
        .ws("/chat", {
          upgrade() {
            throw new Error("upgrade broke")
          },
          message() {},
        })
      const failedHook = server({ logger })
        .use(websocket())
        .onError(failingHook[mode])
        .onRequest(() => {
          throw new Error("store down")
        })
        .ws("/chat", { message() {} })
      for (const app of [failedUpgrade, failedHook]) {
        const outcome = await app.resolveWebSocketUpgrade(upgrade("/chat"))
        expect(outcome.kind).toBe("reject")
        if (outcome.kind !== "reject") continue
        expect(outcome.response.status).toBe(500)
        expect(await outcome.response.json()).toEqual(INTERNAL)
      }
      expect(errors).toEqual(["upgrade broke", "hook broke", "store down", "hook broke"])
    })
  })
}

describe("an onError answer", () => {
  test("a thrown Response or status() is sent as if returned", async () => {
    const { logger, errors } = recorder()
    const app = server({ logger })
      .onError((_error, c) => {
        if (c.req.url.endsWith("/response")) throw new Response("no", { status: 401 })
        throw status(429, { error: "slow_down" })
      })
      .get("/*", () => {
        throw new Error("handler broke")
      })
    const thrown = await app.fetch(get("/response"))
    expect(thrown.status).toBe(401)
    expect(await thrown.text()).toBe("no")
    const result = await app.fetch(get("/status"))
    expect(result.status).toBe(429)
    expect(await result.json()).toEqual({ error: "slow_down" })
    expect(errors).toEqual([])
  })

  test("a thrown status() is still held to the route's response contract", async () => {
    const { logger, errors } = recorder()
    const app = server({ logger })
      .use(responseContract("enforce"))
      .onError(() => {
        throw status(409, { id: "u1", secret: "tok" })
      })
      .get("/", { errors: { 409: z.object({ id: z.string() }) } }, () => {
        throw new Error("handler broke")
      })
    const res = await app.fetch(get())
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ id: "u1" })
    expect(errors).toEqual([])
  })

  test("that cannot be rendered is logged and answered 500", async () => {
    const { logger, errors } = recorder()
    const app = server({ logger })
      .onError(() => ({ id: 1n }))
      .get("/", () => {
        throw new Error("handler broke")
      })
    const res = await app.fetch(get())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual(INTERNAL)
    expect(errors).toEqual(["JSON.stringify cannot serialize BigInt."])
  })
})
