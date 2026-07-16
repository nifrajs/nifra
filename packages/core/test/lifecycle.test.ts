import { describe, expect, test } from "bun:test"
import { networkInterfaces } from "node:os"
import type { StandardSchemaV1 } from "../src/index.ts"
import { server } from "../src/index.ts"
import { nodeDirect } from "../src/node-direct.ts"

/** A non-loopback local IPv4, so "bound to loopback only" is observable. Skipped-safe: falls back
 *  to loopback when the box has no external interface, which makes the negative assertion vacuous
 *  rather than flaky. */
const LOCAL_IPV4 = (() => {
  for (const nets of Object.values(networkInterfaces())) {
    for (const net of nets ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address
    }
  }
  return "127.0.0.1"
})()

const passThrough: StandardSchemaV1 = {
  "~standard": { version: 1, vendor: "test", validate: (value) => ({ value }) },
}

describe("graceful shutdown", () => {
  test("stop() lets an in-flight request drain to completion", async () => {
    const app = server().get("/slow", async () => {
      await Bun.sleep(60)
      return "done"
    })
    const srv = app.listen(0)
    const inflight = fetch(`http://localhost:${srv.port}/slow`)
      .then((r) => r.json())
      .catch(() => "ERR")
    await Bun.sleep(20) // ensure the request is in the handler
    await app.stop()
    expect(await inflight).toBe("done")
  })

  test("a request still running past drainMs is force-closed", async () => {
    const app = server().get("/slow", async () => {
      await Bun.sleep(400)
      return "done"
    })
    const srv = app.listen(0)
    const inflight = fetch(`http://localhost:${srv.port}/slow`)
      .then((r) => r.text())
      .catch(() => "ERR")
    await Bun.sleep(50) // ensure the request is dispatched (pendingRequests > 0)
    await app.stop({ drainMs: 30 }) // drain window expires while the handler is still sleeping
    expect(await inflight).toBe("ERR")
  })

  test("stop() is a no-op when never listening", async () => {
    await expect(server().stop()).resolves.toBeUndefined()
  })

  test("gracefulSignals installs a SIGTERM/SIGINT handler that stops the server", async () => {
    const beforeTerm = process.listenerCount("SIGTERM")
    const beforeInt = process.listenerCount("SIGINT")
    const app = server({ gracefulSignals: true }).get("/", () => "ok")
    const srv = app.listen(0)
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm + 1)
    expect(process.listenerCount("SIGINT")).toBe(beforeInt + 1)

    // Invoke only the handler(s) we added — avoids process.emit touching other listeners.
    const added = process.listeners("SIGTERM").slice(beforeTerm) as Array<(...a: unknown[]) => void>
    for (const handler of added) handler()
    await Bun.sleep(80)

    const refused = await fetch(`http://localhost:${srv.port}/`)
      .then(() => false)
      .catch(() => true)
    expect(refused).toBe(true)

    // Direct invocation doesn't auto-remove `once` listeners; clean up ours.
    for (const h of process.listeners("SIGTERM").slice(beforeTerm))
      process.removeListener("SIGTERM", h as (...a: unknown[]) => void)
    for (const h of process.listeners("SIGINT").slice(beforeInt))
      process.removeListener("SIGINT", h as (...a: unknown[]) => void)
  })
})

describe("request timeout", () => {
  test("a slow handler gets 503 and ctx.signal aborts", async () => {
    let abortedDuringHandler: boolean | undefined
    const app = server({ requestTimeoutMs: 30 }).get("/slow", async (c) => {
      await Bun.sleep(80)
      abortedDuringHandler = c.signal.aborted
      return "late"
    })
    const res = await app.fetch(new Request("http://x/slow"))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, error: "request_timeout" })
    await Bun.sleep(80) // let the (uncancellable) handler run to completion
    expect(abortedDuringHandler).toBe(true)
  })

  test("a fast handler returns normally (timer cleared, no 503)", async () => {
    const app = server({ requestTimeoutMs: 1000 }).get("/fast", () => "ok")
    const res = await app.fetch(new Request("http://x/fast"))
    expect(res.status).toBe(200)
    expect(await res.json()).toBe("ok")
  })
})

describe("body size limits", () => {
  test("Content-Length over the cap is rejected before buffering (413)", async () => {
    const app = server({ maxBodyBytes: 100 }).post("/x", { body: passThrough }, (c) => c.body)
    const srv = app.listen(0)
    try {
      // Over the wire, fetch sets a real Content-Length (~510 bytes > cap).
      const res = await fetch(`http://localhost:${srv.port}/x`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: "x".repeat(500) }),
      })
      expect(res.status).toBe(413)
    } finally {
      await app.stop()
    }
  })

  test("an oversized streamed body (no Content-Length) is capped mid-stream (413)", async () => {
    const app = server({ maxBodyBytes: 100 }).post("/x", { body: passThrough }, (c) => c.body)
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 5; i++) controller.enqueue(encoder.encode("x".repeat(50)))
        controller.close()
      },
    })
    const res = await app.fetch(
      new Request("http://x/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stream,
        duplex: "half",
      } as RequestInit),
    )
    expect(res.status).toBe(413)
  })

  test("a body within the cap is accepted", async () => {
    const app = server({ maxBodyBytes: 1000 }).post("/x", { body: passThrough }, (c) => c.body)
    const res = await app.fetch(
      new Request("http://x/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: "ok" }),
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ a: "ok" })
  })
})

describe("ctx.signal", () => {
  test("is present and not aborted when no timeout is configured", async () => {
    let seen: AbortSignal | undefined
    const app = server().get("/", (c) => {
      seen = c.signal
      return "ok"
    })
    await app.fetch(new Request("http://x/"))
    expect(seen).toBeInstanceOf(AbortSignal)
    expect(seen?.aborted).toBe(false)
  })
})

describe("listen({ reusePort })", () => {
  test("two servers bind the same port and both answer", async () => {
    const make = () => server().get("/", () => ({ pid: "me" }))
    const a = make().listen(0, { reusePort: true })
    // The second bind to the SAME port only succeeds because both sockets set SO_REUSEPORT.
    const b = make().listen(a.port, { reusePort: true })
    try {
      const res = await fetch(`http://127.0.0.1:${a.port}/`)
      expect(await res.json()).toEqual({ pid: "me" })
    } finally {
      a.stop(true)
      b.stop(true)
    }
  })
})

describe("fast JSON respond path parity", () => {
  test("plain return is byte-identical to Response.json (body, content-type, status)", async () => {
    const app = server()
      .get("/obj", () => ({ a: 1, b: "x" }))
      .get("/teapot", (c) => {
        c.set.status = 418
        return { short: "stout" }
      })
      .get("/headers", (c) => {
        c.set.headers["x-k"] = "v" // user headers → slow path, content-type still set
        return { h: true }
      })
    const reference = Response.json({ a: 1, b: "x" })

    const obj = await app.fetch(new Request("http://t/obj"))
    expect(await obj.text()).toBe(JSON.stringify({ a: 1, b: "x" }))
    expect(obj.headers.get("content-type")).toBe(reference.headers.get("content-type"))
    expect(obj.status).toBe(200)

    const teapot = await app.fetch(new Request("http://t/teapot"))
    expect(teapot.status).toBe(418)
    expect(teapot.headers.get("content-type")).toBe(reference.headers.get("content-type"))
    expect(await teapot.json()).toEqual({ short: "stout" })

    const withHeaders = await app.fetch(new Request("http://t/headers"))
    expect(withHeaders.headers.get("x-k")).toBe("v")
    expect(withHeaders.headers.get("content-type")).toBe(reference.headers.get("content-type"))
  })

  test("shared init never leaks mutations across responses", async () => {
    const app = server().get("/one", () => ({ n: 1 }))
    const a = await app.fetch(new Request("http://t/one"))
    a.headers.set("x-mutate", "leak?")
    a.headers.append("set-cookie", "s=1")
    const b = await app.fetch(new Request("http://t/one"))
    expect(b.headers.get("x-mutate")).toBeNull()
    expect(b.headers.get("set-cookie")).toBeNull()
  })

  test("cookies still ride plain returns (slow path preserved)", async () => {
    const app = server().get("/c", (c) => {
      c.set.cookie("sid", "abc", { secure: false })
      return { ok: true }
    })
    const res = await app.fetch(new Request("http://t/c"))
    expect(res.headers.get("set-cookie")).toContain("sid=abc")
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe("fused web lane parity (bare routes)", () => {
  // The fused lane only runs on fetch(); resolveNode keeps the generic path — drive BOTH and
  // assert equal output so the lanes can never drift.
  test("fetch (fused) and resolveNode (generic) agree on body/status", async () => {
    const make = () =>
      server()
        .use(nodeDirect())
        .get("/sync", (c) => ({ id: c.params, ok: true }))
        .get("/async", async () => ({ later: 1 }))
        .get("/set", (c) => {
          c.set.status = 201
          c.set.headers["x-f"] = "1"
          return { made: true }
        })
        .get("/throw", () => {
          throw new Error("boom")
        })
        .get("/throw-response", () => {
          throw new Response("teapot", { status: 418 })
        })
        .get("/contextless", () => ({ zero: "args" }))
    for (const path of ["/sync", "/async", "/set", "/throw", "/throw-response", "/contextless"]) {
      const viaFetch = await make().fetch(new Request(`http://t${path}`))
      const viaNode = await make().resolveNode(new Request(`http://t${path}`))
      const nodeRes =
        viaNode.kind === "response"
          ? viaNode.response
          : viaNode.kind === "json"
            ? new Response(viaNode.body, { status: viaNode.status })
            : new Response(viaNode.body as string | null, { status: viaNode.status })
      expect(viaFetch.status).toBe(nodeRes.status)
      expect(await viaFetch.text()).toBe(await nodeRes.text())
    }
  })

  test("fused lane respects set.cookie on bare routes", async () => {
    const app = server().get("/c", (c) => {
      c.set.cookie("a", "b", { secure: false })
      return { ok: 1 }
    })
    const res = await app.fetch(new Request("http://t/c"))
    expect(res.headers.get("set-cookie")).toContain("a=b")
  })

  test("around hooks force the generic lane (no fused bypass)", async () => {
    let wrapped = 0
    const app = server()
      .use({
        around: async (_c, next) => {
          wrapped++
          return next()
        },
      })
      .get("/a", () => ({ ok: true }))
    const res = await app.fetch(new Request("http://t/a"))
    expect(res.status).toBe(200)
    expect(wrapped).toBe(1)
  })

  test("thrown error on fused lane logs and 500s without leaking the message", async () => {
    const logs: string[] = []
    const app = server({
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (msg) => {
          logs.push(msg)
        },
      },
    }).get("/boom", () => {
      throw new Error("secret detail")
    })
    const res = await app.fetch(new Request("http://t/boom"))
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain("secret detail")
    expect(logs.length).toBe(1)
  })
})

describe("listen({ hostname })", () => {
  test("binds the given hostname, and defaults to every interface without it", async () => {
    const app = server().get("/x", () => "ok")
    const srv = app.listen(0, { hostname: "127.0.0.1" })
    expect(srv.hostname).toBe("127.0.0.1")
    // Reachable on loopback...
    expect(await fetch(`http://127.0.0.1:${srv.port}/x`).then((r) => r.json())).toBe("ok")
    // ...and NOT on another local interface - the point of binding at all. Asserting the bind
    // took effect, not merely that the option was accepted: a silently ignored hostname is the
    // whole hazard (a service meant for loopback answering the network).
    const external = await fetch(`http://${LOCAL_IPV4}:${srv.port}/x`).then(
      (r) => r.status as number | string,
      () => "unreachable",
    )
    expect(external).toBe("unreachable")
    await app.stop()

    // No hostname → Bun's default bind, every interface. (Bun REPORTS `hostname` as "localhost"
    // here while binding 0.0.0.0, so assert the reachability rather than the label.)
    const wide = server().get("/x", () => "ok")
    const wideSrv = wide.listen(0)
    expect(await fetch(`http://${LOCAL_IPV4}:${wideSrv.port}/x`).then((r) => r.json())).toBe("ok")
    await wide.stop()
  })
})

describe("listen() configuration seal", () => {
  test("rejects policy mutation after native routes are compiled", async () => {
    const app = server().get("/a", () => ({ ok: true }))
    const running = app.listen(0, { hostname: "127.0.0.1" })
    try {
      expect(() => app.onRequest(() => new Response("blocked", { status: 403 }))).toThrow(
        /sealed after listen/,
      )
      expect(() => app.get("/late", () => "late")).toThrow(/sealed after listen/)
      expect((await app.fetch(new Request("http://x/a"))).status).toBe(200)
      expect((await app.fetch(new Request("http://x/late"))).status).toBe(404)
      expect((await fetch(`http://127.0.0.1:${running.port}/a`)).status).toBe(200)
      expect((await fetch(`http://127.0.0.1:${running.port}/late`)).status).toBe(404)
    } finally {
      await running.stop(true)
    }
  })
})
