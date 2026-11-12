import { describe, expect, test } from "bun:test"
import { connect } from "node:net"
import { t } from "@nifrajs/schema"
import { type Platform, server, silentLogger } from "../src/index.ts"
import type { Context } from "../src/server/context.ts"
import { withIdleTimeout } from "../src/server/idle-timeout.ts"
import { PLATFORM_IDLE_TIMEOUT } from "../src/server/request-context.ts"
import { CONTEXT_IDLE_TIMEOUT } from "../src/server/runtime-core.ts"
import { websocket } from "../src/ws.ts"

/** A platform standing in for a Bun listener: it records each value the request's timeout is set to. */
function recordingPlatform(): {
  readonly calls: (number | "listener")[]
  readonly platform: Platform
} {
  const calls: (number | "listener")[] = []
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the platform carries only the listener key a Bun listen() sets; every other Platform field is optional.
  const platform = {
    [PLATFORM_IDLE_TIMEOUT]: (_source: unknown, seconds: number | undefined) => {
      calls.push(seconds ?? "listener")
    },
  } as Platform
  return { calls, platform }
}

/** The two members `withIdleTimeout` reads, for driving scopes without a server. */
function recordingContext(signal = new AbortController().signal) {
  const calls: (number | "listener")[] = []
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: a stand-in with only the two members withIdleTimeout reads, signal and the listener key.
  const context = {
    signal,
    [CONTEXT_IDLE_TIMEOUT]: (seconds: number | undefined) => {
      calls.push(seconds ?? "listener")
      return true
    },
  } as unknown as Context
  return { calls, context }
}

describe("withIdleTimeout()", () => {
  test("sets the timeout while the work runs and puts the listener's back before the response", async () => {
    const { calls, platform } = recordingPlatform()
    const gate = Promise.withResolvers<void>()
    let during: (number | "listener")[] = []
    const app = server().get("/export", (c) =>
      withIdleTimeout(c, 0, async () => {
        during = [...calls]
        await gate.promise
        return { done: true }
      }),
    )
    const pending = app.fetch(new Request("http://x/export"), platform)
    await Bun.sleep(0)
    gate.resolve()
    const res = await pending
    expect(await res.json()).toEqual({ done: true })
    expect(during).toEqual([0])
    expect(calls).toEqual([0, "listener"])
  })

  test("synchronous work answers synchronously", () => {
    const { calls, context } = recordingContext()
    expect(withIdleTimeout(context, 30, () => "ready")).toBe("ready")
    expect(calls).toEqual([30, "listener"])
  })

  test("a synchronous throw puts the listener's back and reaches the caller", () => {
    const { calls, context } = recordingContext()
    expect(() =>
      withIdleTimeout(context, 0, () => {
        throw new Error("bad input")
      }),
    ).toThrow("bad input")
    expect(calls).toEqual([0, "listener"])
  })

  test("a throw from the work still puts the listener's back", async () => {
    const { calls, platform } = recordingPlatform()
    const app = server({ logger: silentLogger }).get("/boom", (c) =>
      withIdleTimeout(c, 0, async () => {
        throw new Error("upstream failed")
      }),
    )
    const res = await app.fetch(new Request("http://x/boom"), platform)
    expect(res.status).toBe(500)
    expect(calls).toEqual([0, "listener"])
  })

  test("nested scopes hold the longest, and 0 outlasts any number", async () => {
    const { calls, platform } = recordingPlatform()
    const app = server()
      .around((c, next) => withIdleTimeout(c, 120, next))
      .get("/nested", (c) => withIdleTimeout(c, 0, () => ({ ok: true })))
    const res = await app.fetch(new Request("http://x/nested"), platform)
    expect(res.status).toBe(200)
    expect(calls).toEqual([120, 0, 120, "listener"])
  })

  test("concurrent scopes on one request put the listener's back only when the last ends", async () => {
    const { calls, context } = recordingContext()
    const short = Promise.withResolvers<void>()
    const off = Promise.withResolvers<void>()
    const a = withIdleTimeout(context, 30, () => short.promise)
    const b = withIdleTimeout(context, 0, () => off.promise)
    expect(calls).toEqual([30, 0])
    off.resolve()
    await b
    expect(calls).toEqual([30, 0, 30])
    short.resolve()
    await a
    expect(calls).toEqual([30, 0, 30, "listener"])
  })

  test("a request deadline puts the listener's back before the 503, and the late settle leaves it", async () => {
    const { calls, platform } = recordingPlatform()
    const gate = Promise.withResolvers<void>()
    let settled = Promise.resolve()
    const app = server({ requestTimeoutMs: 20 }).get("/stuck", (c) => {
      const scope = withIdleTimeout(c, 0, () => gate.promise)
      settled = Promise.resolve(scope)
      return scope
    })
    const res = await app.fetch(new Request("http://x/stuck"), platform)
    expect(res.status).toBe(503)
    expect(calls).toEqual([0, "listener"])
    gate.resolve()
    await settled
    expect(calls).toEqual([0, "listener"])
  })

  test("an already aborted request runs the work without touching the timeout", () => {
    const controller = new AbortController()
    controller.abort()
    const { calls, context } = recordingContext(controller.signal)
    expect(withIdleTimeout(context, 0, () => "late")).toBe("late")
    expect(calls).toEqual([])
  })

  test("off listen() the work runs unchanged", async () => {
    const app = server().get("/plain", (c) => withIdleTimeout(c, 0, () => ({ ran: true })))
    const res = await app.fetch(new Request("http://x/plain"))
    expect(await res.json()).toEqual({ ran: true })
  })

  test("a route with a body, query or headers schema passes its own context", async () => {
    const app = server()
      .post("/body", { body: t.object({ n: t.integer() }) }, (c) =>
        withIdleTimeout(c, 0, () => c.body),
      )
      .get("/query", { query: t.object({ q: t.string() }) }, (c) =>
        withIdleTimeout(c, 0, () => c.query),
      )
      .get("/headers", { headers: t.object({ "x-k": t.string() }) }, (c) =>
        withIdleTimeout(c, 0, async () => c.headers),
      )
    const post = await app.fetch(
      new Request("http://x/body", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ n: 3 }),
      }),
    )
    expect(await post.json()).toEqual({ n: 3 })
    const query = await app.fetch(new Request("http://x/query?q=a"))
    expect(await query.json()).toEqual({ q: "a" })
    const headers = await app.fetch(new Request("http://x/headers", { headers: { "x-k": "v" } }))
    expect((await headers.json())["x-k"]).toBe("v")
  })

  test("refuses a negative, fractional, non-finite or over-255 number of seconds", () => {
    const { calls, context } = recordingContext()
    let ran = 0
    for (const seconds of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 256]) {
      expect(() => withIdleTimeout(context, seconds, () => ran++)).toThrow(RangeError)
    }
    expect(ran).toBe(0)
    expect(calls).toEqual([])
    expect(withIdleTimeout(context, 255, () => ran++)).toBe(0)
    expect(calls).toEqual([255, "listener"])
  })

  test("a mounted app's routes reach the listener's control", async () => {
    const { calls, platform } = recordingPlatform()
    const child = server().get("/report", (c) => withIdleTimeout(c, 0, () => ({ child: true })))
    const app = server().mount({ path: "/api", app: child, stripPrefix: true })
    const res = await app.fetch(new Request("http://x/api/report"), platform)
    expect(await res.json()).toEqual({ child: true })
    expect(calls).toEqual([0, "listener"])
  })
})

interface TimeoutCall {
  readonly seconds: number
  /** Bun answers `requestIP` only for a request it handed in, so this tells its own from a copy. */
  readonly bunsOwn: boolean
}

/** Record the calls a running Bun server's `timeout` gets, passing each one on. */
async function withTimeoutSpy(
  running: object,
  run: (calls: readonly TimeoutCall[]) => Promise<void>,
): Promise<void> {
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: `running` is a Bun Server, whose prototype holds timeout and requestIP.
  const proto = Object.getPrototypeOf(running) as {
    timeout(request: Request, seconds: number): void
    requestIP(request: Request): unknown
  }
  const original = proto.timeout
  const calls: TimeoutCall[] = []
  proto.timeout = function (this: typeof proto, request: Request, seconds: number) {
    calls.push({ seconds, bunsOwn: this.requestIP(request) !== null })
    original.call(this, request, seconds)
  }
  try {
    await run(calls)
  } finally {
    proto.timeout = original
  }
}

describe("withIdleTimeout() on listen()", () => {
  const slow = (c: Context) => withIdleTimeout(c, 0, async () => ({ ok: true }))

  test("a route on Bun's native table times Bun's own request, then puts back idleTimeoutSec", async () => {
    const app = server().get("/slow", slow)
    const running = app.listen(0, { hostname: "127.0.0.1", idleTimeoutSec: 7 })
    try {
      await withTimeoutSpy(running, async (calls) => {
        const res = await fetch(`http://127.0.0.1:${running.port}/slow`)
        expect(res.status).toBe(200)
        expect(calls).toEqual([
          { seconds: 0, bunsOwn: true },
          { seconds: 7, bunsOwn: true },
        ])
      })
    } finally {
      await app.stop({ drainMs: 0 })
    }
  })

  test("a rewritten request still times the one Bun handed in, and Bun's 10s default comes back", async () => {
    const app = server()
      .onRequest((req) => new Request(new URL("/slow", req.url), req))
      .get("/slow", slow)
    const running = app.listen(0, { hostname: "127.0.0.1" })
    try {
      await withTimeoutSpy(running, async (calls) => {
        const res = await fetch(`http://127.0.0.1:${running.port}/anything`)
        expect(res.status).toBe(200)
        expect(calls).toEqual([
          { seconds: 0, bunsOwn: true },
          { seconds: 10, bunsOwn: true },
        ])
      })
    } finally {
      await app.stop({ drainMs: 0 })
    }
  })

  test("an app with WebSocket routes reaches it on its HTTP routes", async () => {
    const app = server()
      .use(websocket())
      .ws("/sock", { message: () => {} })
      .get("/slow", slow)
    const running = app.listen(0, { hostname: "127.0.0.1", idleTimeoutSec: 3 })
    try {
      await withTimeoutSpy(running, async (calls) => {
        const res = await fetch(`http://127.0.0.1:${running.port}/slow`)
        expect(res.status).toBe(200)
        expect(calls).toEqual([
          { seconds: 0, bunsOwn: true },
          { seconds: 3, bunsOwn: true },
        ])
      })
    } finally {
      await app.stop({ drainMs: 0 })
    }
  })

  test("Bun keeps a slow handler's connection past idleTimeoutSec, then idles it out once answered", async () => {
    // Bun's timer wheel cuts a 1s idle connection at about 4s, so the handler outlasts it at 5s.
    const app = server().get("/slow", (c) =>
      withIdleTimeout(c, 0, () => Bun.sleep(5000).then(() => "done")),
    )
    const running = app.listen(0, { hostname: "127.0.0.1", idleTimeoutSec: 1 })
    try {
      const outcome = await new Promise<{ body: string; closedAfterAnswer: boolean }>((resolve) => {
        const socket = connect(running.port, "127.0.0.1")
        let text = ""
        let answered = false
        socket.on("connect", () => socket.write("GET /slow HTTP/1.1\r\nHost: x\r\n\r\n"))
        socket.on("data", (chunk) => {
          text += chunk.toString()
          if (text.includes("done")) answered = true
        })
        // Without the timeout put back, the server would hold this idle keep-alive socket open.
        socket.on("close", () => resolve({ body: text, closedAfterAnswer: answered }))
      })
      expect(outcome.body).toContain("done")
      expect(outcome.closedAfterAnswer).toBe(true)
    } finally {
      await app.stop({ drainMs: 0 })
    }
  }, 30_000)
})
