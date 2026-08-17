import { server } from "@nifrajs/core"
import { responseObserver } from "@nifrajs/core/response-observer"
import { websocket } from "@nifrajs/core/ws"
import { serve } from "../src/index.ts"

// Minimal local assertions - keeps `deno test` offline + dependency-free.
function assertEquals(actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`assertEquals failed:\n  actual:   ${a}\n  expected: ${e}`)
}
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

Deno.test("serves GET (JSON) + POST (body), resolves the bound port", async () => {
  const app = server()
    .use(responseObserver())
    .get("/users/:id", (c) => ({ id: c.params.id }))
    .post("/echo", (c) => c.req.json())
  const running = await serve(app, { port: 0 })
  try {
    assert(running.port > 0, "port should be resolved")
    const base = `http://localhost:${running.port}`
    assertEquals(await (await fetch(`${base}/users/42`)).json(), { id: "42" })
    const echoed = await fetch(`${base}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hi: "there" }),
    })
    assertEquals(await echoed.json(), { hi: "there" })
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

Deno.test("passes a 204 (no body) through correctly", async () => {
  const app = server().get("/empty", (c) => {
    c.set.status = 204
    return undefined
  })
  const running = await serve(app, { port: 0 })
  try {
    const res = await fetch(`http://localhost:${running.port}/empty`)
    assertEquals(res.status, 204)
    assertEquals(await res.text(), "")
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

Deno.test("a throwing app yields a flat 500 (no leak)", async () => {
  const running = await serve(
    {
      fetch: () => {
        throw new Error("boom")
      },
    },
    { port: 0 },
  )
  try {
    const res = await fetch(`http://localhost:${running.port}/`)
    assertEquals(res.status, 500)
    assertEquals(await res.json(), { ok: false, error: "internal_error" })
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

Deno.test("stop() drains an in-flight request, then is idempotent", async () => {
  const app = server().get("/slow", async () => {
    await new Promise((resolve) => setTimeout(resolve, 80))
    return { done: true }
  })
  const running = await serve(app, { port: 0 })
  const inflight = fetch(`http://localhost:${running.port}/slow`)
    .then((r) => r.json())
    .catch(() => "ERR")
  await new Promise((resolve) => setTimeout(resolve, 20)) // ensure the request is in-flight
  await running.stop({ drainMs: 1000 })
  assertEquals(await inflight, { done: true })
  await running.stop() // second call is a no-op (idempotent)
})

Deno.test("inherits the app-level requestTimeoutMs (503) through app.fetch", async () => {
  const app = server({ requestTimeoutMs: 40 }).get("/slow", async (c) => {
    // Respect the abort signal so the handler's timer clears on timeout - otherwise
    // Deno's resource sanitizer would flag the leaked setTimeout.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 200)
      c.signal.addEventListener("abort", () => {
        clearTimeout(timer)
        resolve()
      })
    })
    return { done: true }
  })
  const running = await serve(app, { port: 0 })
  try {
    const res = await fetch(`http://localhost:${running.port}/slow`)
    assertEquals(res.status, 503)
    assertEquals(await res.json(), { ok: false, error: "request_timeout" })
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

Deno.test("app.listen() throws a clear, actionable error on non-Bun runtimes", () => {
  // This suite runs under Deno, where `Bun` is undefined - so listen()'s guard fires.
  // (Under `bun test`, `Bun` is always defined, so this path can only be checked here.)
  const app = server().get("/", () => ({ ok: true }))
  let caught: Error | undefined
  try {
    app.listen(0)
  } catch (e) {
    caught = e instanceof Error ? e : new Error(String(e))
  }
  assert(caught !== undefined, "listen() should throw on Deno (Bun is undefined)")
  assert(
    caught.message.includes("@nifrajs/node") && caught.message.includes("@nifrajs/deno"),
    `expected the error to point at the adapters, got: ${caught.message}`,
  )
})

// The adapter no longer pre-filters on the `Upgrade` header (that probe forced a per-request header
// materialization for every plain HTTP request); it calls the core seam directly instead. These pin
// the behavior that change could plausibly break: a real handshake still upgrades and round-trips,
// an `upgrade()` guard's rejection is still returned as HTTP, and a WS-free app still serves HTTP
// normally even when a client sends an `Upgrade` header.
Deno.test("WebSocket: upgrades, echoes, and honors an upgrade() guard", async () => {
  const app = server()
    .use(websocket())
    .ws("/echo", {
      open: (ws) => ws.send("welcome"),
      message: (ws, data) => ws.send(data),
    })
    .ws("/guarded", {
      upgrade: (c) => {
        if (new URL(c.req.url).searchParams.get("token") !== "secret") {
          return new Response("unauthorized", { status: 401 })
        }
        return {}
      },
      open: (ws) => ws.send("allowed"),
    })
    .get("/health", () => ({ ok: true }))
  const running = await serve(app, { port: 0 })
  try {
    const wsBase = `ws://localhost:${running.port}`

    const frames = await new Promise<string[]>((resolve, reject) => {
      const got: string[] = []
      const socket = new WebSocket(`${wsBase}/echo`)
      const timer = setTimeout(() => reject(new Error("ws timed out")), 5000)
      socket.onmessage = (ev) => {
        got.push(String(ev.data))
        if (got.length === 1) socket.send("ping")
        else {
          clearTimeout(timer)
          socket.close()
          resolve(got)
        }
      }
      socket.onerror = () => {
        clearTimeout(timer)
        reject(new Error("ws errored"))
      }
    })
    assertEquals(frames, ["welcome", "ping"])

    // A rejected upgrade comes back as a plain HTTP response, not a socket.
    const denied = await fetch(`http://localhost:${running.port}/guarded?token=wrong`, {
      headers: { upgrade: "websocket", connection: "Upgrade" },
    })
    await denied.body?.cancel()
    assertEquals(denied.status, 401)

    // Normal HTTP is unaffected on an app that also has WS routes.
    assertEquals(await (await fetch(`http://localhost:${running.port}/health`)).json(), {
      ok: true,
    })
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

Deno.test("a WS-free app serves HTTP normally even when the client sends an Upgrade header", async () => {
  const app = server().get("/health", () => ({ ok: true }))
  const running = await serve(app, { port: 0 })
  try {
    const res = await fetch(`http://localhost:${running.port}/health`, {
      headers: { upgrade: "websocket", connection: "Upgrade" },
    })
    assertEquals(await res.json(), { ok: true })
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

Deno.test("portable response tiers serve end to end on the fetch path", async () => {
  // Pins the portable tiers' wire behavior on a non-Bun runtime: header tier (set/append/get),
  // body tier (observe + conditional 304), queued cookies, and handler-returned raw Responses.
  const app = server()
    .use(responseObserver())
    .onResponseHeaders((headers, _req, status) => {
      headers.set("x-sec", "nosniff")
      headers.set("x-status-seen", String(status))
      headers.append("x-multi", "one")
      headers.append("x-multi", "two")
    })
    .onResponseBody((body, headers, req) => {
      const text = typeof body === "string" ? body : new TextDecoder().decode(body)
      if (req.header("if-none-match") === '"tag"') return { body: null, status: 304 }
      headers.set("x-body-len", String(text.length))
      return undefined
    })
    .get("/json", (c) => {
      c.set.headers["x-request-id"] = "rid-1"
      return { ok: true }
    })
    .get("/cookie", (c) => {
      c.set.cookie("session", "abc", { path: "/" })
      return { ok: true }
    })
    .get("/raw", () => new Response("<h1>hi</h1>", { headers: { "content-type": "text/html" } }))
  const running = await serve(app, { port: 0 })
  try {
    const base = `http://localhost:${running.port}`
    const res = await fetch(`${base}/json`)
    assertEquals(res.status, 200)
    assertEquals(res.headers.get("x-request-id"), "rid-1")
    assertEquals(res.headers.get("x-sec"), "nosniff")
    assertEquals(res.headers.get("x-status-seen"), "200")
    assertEquals(res.headers.get("x-multi"), "one, two")
    assertEquals(res.headers.get("content-type"), "application/json;charset=utf-8")
    const body = await res.text()
    assertEquals(res.headers.get("x-body-len"), String(body.length))
    assertEquals(JSON.parse(body), { ok: true })

    const cached = await fetch(`${base}/json`, { headers: { "if-none-match": '"tag"' } })
    assertEquals(cached.status, 304)
    assertEquals(await cached.text(), "")
    assertEquals(cached.headers.get("x-sec"), "nosniff")

    const cookie = await fetch(`${base}/cookie`)
    assertEquals(cookie.headers.getSetCookie(), [
      "session=abc; Path=/; HttpOnly; Secure; SameSite=Lax",
    ])
    assertEquals((await cookie.json()).ok, true)

    const raw = await fetch(`${base}/raw`)
    assertEquals(raw.headers.get("content-type"), "text/html")
    assertEquals(raw.headers.get("x-sec"), "nosniff")
    assertEquals(await raw.text(), "<h1>hi</h1>")
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

Deno.test("statically declared response headers match the equivalent hook on the wire", async () => {
  // Deno reaches these through the Web render paths, so this is where the record-vs-prebuilt-init
  // split gets exercised on a V8 runtime: a bare JSON render, one carrying c.set.headers, one whose
  // casing collides with a declared name, cookies, a raw Response, an error, and a 404.
  const declared: Record<string, string> = {
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  }
  const routes = (app: ReturnType<typeof server>) =>
    app
      .get("/json", () => ({ ok: true }))
      .get("/own", (c) => {
        c.set.headers["x-own"] = "1"
        return { ok: true }
      })
      .get("/collision", (c) => {
        c.set.headers["X-Frame-Options"] = "SAMEORIGIN"
        return { ok: true }
      })
      .get("/cookie", (c) => {
        c.set.cookie("session", "abc", { path: "/" })
        return { ok: true }
      })
      .get("/raw", () => new Response("<h1>hi</h1>", { headers: { "content-type": "text/html" } }))
      .get("/boom", () => {
        throw new Error("x")
      })
  const paths = ["/json", "/own", "/collision", "/cookie", "/raw", "/boom", "/missing"]

  const dumpAll = async (app: ReturnType<typeof server>): Promise<unknown[]> => {
    const running = await serve(app, { port: 0 })
    try {
      const out: unknown[] = []
      for (const path of paths) {
        const res = await fetch(`http://localhost:${running.port}${path}`)
        const headers = [...res.headers]
          .filter(([name]) => name !== "date" && name !== "vary")
          .map(([name, value]) => [name, value])
        headers.sort()
        out.push({ path, status: res.status, headers, body: await res.text() })
      }
      return out
    } finally {
      await running.stop({ drainMs: 0 })
    }
  }

  const viaStatic = await dumpAll(
    routes(server({ logger: { error() {}, warn() {}, info() {} } as never })).responseHeaders(
      declared,
    ),
  )
  const viaHook = await dumpAll(
    routes(server({ logger: { error() {}, warn() {}, info() {} } as never }))
      .use(responseObserver())
      .onResponseHeaders((headers) => {
        for (const [name, value] of Object.entries(declared)) {
          if (!headers.has(name)) headers.set(name, value)
        }
      }),
  )
  assertEquals(viaStatic, viaHook)
  for (const entry of viaStatic as Array<{ headers: string[][] }>) {
    assert(
      entry.headers.some(([n, v]) => n === "referrer-policy" && v === "no-referrer"),
      "declared header missing from a Deno response",
    )
  }
  const collision = (viaStatic as Array<{ path: string; headers: string[][] }>).find(
    (entry) => entry.path === "/collision",
  )
  assertEquals(
    collision?.headers.filter(([name]) => name === "x-frame-options"),
    [["x-frame-options", "SAMEORIGIN"]],
  )
})
