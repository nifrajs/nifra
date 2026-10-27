import { type StandardSchemaV1, server, status } from "@nifrajs/core"
import { method } from "@nifrajs/core/methods"
import { responseObserver } from "@nifrajs/core/response-observer"
import { websocket } from "@nifrajs/core/ws"
import { selfSignedCertificate } from "../../../internal/test-utils/src/tls.ts"
import {
  invalidHostMismatches,
  rawExchange,
  rawUpgradeStatus,
  refusedHostMismatches,
  requestTargetApp,
  requestTargetMismatches,
} from "../../core/test/request-target-matrix.ts"
import {
  closeArgsAnswers,
  closeArgsRoute,
  closeReportRoute,
  closeReports,
  closeWithoutCode,
  FORBIDDEN_CLOSES,
  REPORT_CAP,
  SERVER_CLOSE_REPORTS,
} from "../../core/test/ws-close-args.ts"
import { firstContractFrame, sendContractApp } from "../../core/test/ws-send-contract.ts"
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
  const running = await serve(app, { hostname: "127.0.0.1", port: 0 })
  try {
    assert(running.port > 0, "port should be resolved")
    const base = `http://127.0.0.1:${running.port}`
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
  const running = await serve(app, { hostname: "127.0.0.1", port: 0 })
  try {
    const res = await fetch(`http://127.0.0.1:${running.port}/empty`)
    assertEquals(res.status, 204)
    assertEquals(await res.text(), "")
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

Deno.test("the old `signals` option is refused and names gracefulSignals", () => {
  const options = { hostname: "127.0.0.1", port: 0, signals: true }
  let message = ""
  try {
    Reflect.apply(serve, undefined, [{ fetch: () => new Response("") }, options])
  } catch (error) {
    message = error instanceof TypeError ? error.message : ""
  }
  assert(
    message.includes("gracefulSignals"),
    `expected a TypeError naming gracefulSignals, got "${message}"`,
  )
})

Deno.test("a throwing app yields a flat 500 (no leak)", async () => {
  const running = await serve(
    {
      fetch: () => {
        throw new Error("boom")
      },
    },
    { hostname: "127.0.0.1", port: 0 },
  )
  try {
    const res = await fetch(`http://127.0.0.1:${running.port}/`)
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
  const running = await serve(app, { hostname: "127.0.0.1", port: 0 })
  const inflight = fetch(`http://127.0.0.1:${running.port}/slow`)
    .then((r) => r.json())
    .catch(() => "ERR")
  await new Promise((resolve) => setTimeout(resolve, 20)) // ensure the request is in-flight
  await running.stop({ drainMs: 1000 })
  assertEquals(await inflight, { done: true })
  await running.stop() // second call is a no-op (idempotent)
})

Deno.test("stop() runs the app's onStopping hooks, serves through delayMs, then runs onStop", async () => {
  const events: string[] = []
  let entered!: () => void
  const stopping = new Promise<void>((resolve) => {
    entered = resolve
  })
  let stoppingAt = 0
  const app = server()
    .onStopping(() => {
      events.push("stopping")
      stoppingAt = performance.now()
      entered()
    })
    .onStop(() => {
      events.push(
        `stopped after ${performance.now() - stoppingAt >= 290 ? "the delay" : "too soon"}`,
      )
    })
    .get("/", () => ({ ok: true }))
  const running = await serve(app, { hostname: "127.0.0.1", port: 0 })
  const stopped = running.stop({ delayMs: 300, drainMs: 1000 })
  await stopping
  const res = await fetch(`http://127.0.0.1:${running.port}/`)
  await res.body?.cancel()
  events.push(`served ${res.status}`)
  await stopped
  assertEquals(events, ["stopping", "served 200", "stopped after the delay"])
})

Deno.test("stop() force-closes a handler that outlives the drain deadline", async () => {
  let resolveStarted: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve
  })
  const app = server().get("/hang", async (c) => {
    resolveStarted?.()
    await new Promise<void>((resolve) => {
      if (c.signal.aborted) {
        resolve()
        return
      }
      c.signal.addEventListener("abort", resolve, { once: true })
    })
    return { done: true }
  })
  const running = await serve(app, { hostname: "127.0.0.1", port: 0 })
  const inflight = fetch(`http://127.0.0.1:${running.port}/hang`).catch(() => undefined)
  await started
  const before = performance.now()
  await running.stop({ drainMs: 10 })
  const elapsed = performance.now() - before
  await inflight
  assert(elapsed < 1000, `stop should force-close near its deadline, took ${elapsed}ms`)
})

Deno.test("stop() force-closes a streamed body that outlives the drain deadline", async () => {
  const encoder = new TextEncoder()
  const app = {
    fetch: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("first chunk\n"))
          },
        }),
      ),
  }
  const running = await serve(app, { hostname: "127.0.0.1", port: 0 })
  const res = await fetch(`http://127.0.0.1:${running.port}/stream`)
  const reader = res.body?.getReader()
  await reader?.read()
  const before = performance.now()
  await running.stop({ drainMs: 10 })
  const elapsed = performance.now() - before
  await reader?.cancel().catch(() => {})
  assert(
    elapsed < 1000,
    `stop should force-close a live stream near its deadline, took ${elapsed}ms`,
  )
})

Deno.test("stop() lets a streamed body that ends within the deadline finish", async () => {
  const encoder = new TextEncoder()
  let finish: (() => void) | undefined
  const app = {
    fetch: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("first,"))
            finish = () => {
              controller.enqueue(encoder.encode("last"))
              controller.close()
            }
          },
        }),
      ),
  }
  const running = await serve(app, { hostname: "127.0.0.1", port: 0 })
  const res = await fetch(`http://127.0.0.1:${running.port}/stream`)
  const reader = res.body?.getReader()
  const first = await reader?.read()
  const stopped = running.stop({ drainMs: 5000 })
  finish?.()
  const decoder = new TextDecoder()
  let body = decoder.decode(first?.value)
  for (;;) {
    const chunk = await reader?.read()
    if (chunk === undefined || chunk.done) break
    body += decoder.decode(chunk.value)
  }
  await stopped
  assertEquals(body, "first,last")
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
  const running = await serve(app, { hostname: "127.0.0.1", port: 0 })
  try {
    const res = await fetch(`http://127.0.0.1:${running.port}/slow`)
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
  const running = await serve(app, { hostname: "127.0.0.1", port: 0 })
  try {
    const wsBase = `ws://127.0.0.1:${running.port}`

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
    const denied = await fetch(`http://127.0.0.1:${running.port}/guarded?token=wrong`, {
      headers: { upgrade: "websocket", connection: "Upgrade" },
    })
    await denied.body?.cancel()
    assertEquals(denied.status, 401)

    // Normal HTTP is unaffected on an app that also has WS routes.
    assertEquals(await (await fetch(`http://127.0.0.1:${running.port}/health`)).json(), {
      ok: true,
    })
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

Deno.test("a frame the route's sendSchema refuses never leaves, as on Bun", async () => {
  const contract = sendContractApp(server().use(websocket()))
  const running = await serve(contract.app, { hostname: "127.0.0.1", port: 0 })
  try {
    assertEquals(await firstContractFrame(running.port), JSON.stringify({ ok: true }))
    assertEquals(contract.errors.length, 1)
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

/** Send one text frame and report the echo, or the close code when the server closes instead. */
function echoOrClose(url: string, message: string): Promise<{ echo: string } | { close: number }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => reject(new Error("ws timed out")), 5000)
    socket.onopen = () => socket.send(message)
    socket.onmessage = (ev) => {
      clearTimeout(timer)
      socket.close()
      resolve({ echo: String(ev.data) })
    }
    socket.onclose = (ev) => {
      clearTimeout(timer)
      resolve({ close: ev.code })
    }
  })
}

Deno.test("wsMaxPayloadBytes counts UTF-8 bytes and sizes a message without copying it", async () => {
  const app = server({ wsMaxPayloadBytes: 16 })
    .use(websocket())
    .ws("/echo", { message: (ws, data) => ws.send(data) })
  const running = await serve(app, { hostname: "127.0.0.1", port: 0 })
  const encode = Object.getOwnPropertyDescriptor(TextEncoder.prototype, "encode")
  const encoded: string[] = []
  Object.defineProperty(TextEncoder.prototype, "encode", {
    configurable: true,
    value(this: TextEncoder, input?: string) {
      encoded.push(input ?? "")
      return encode?.value.call(this, input)
    },
  })
  try {
    const url = `ws://127.0.0.1:${running.port}/echo`
    assertEquals(await echoOrClose(url, "é".repeat(8)), { echo: "é".repeat(8) })
    assertEquals(await echoOrClose(url, "😀".repeat(4)), { echo: "😀".repeat(4) })
    assertEquals(await echoOrClose(url, "é".repeat(9)), { close: 1009 })
    assertEquals(await echoOrClose(url, "x".repeat(17)), { close: 1009 })
    assert(
      !encoded.some((input) => input.startsWith("é") || input.startsWith("😀")),
      "the size check encoded a message to measure it",
    )
  } finally {
    if (encode !== undefined) Object.defineProperty(TextEncoder.prototype, "encode", encode)
    await running.stop({ drainMs: 0 })
  }
})

Deno.test("a close RFC 6455 forbids throws a RangeError and leaves the socket open", async () => {
  const running = await serve(closeArgsRoute(server().use(websocket())), {
    hostname: "127.0.0.1",
    port: 0,
  })
  try {
    assertEquals(await closeArgsAnswers(running.port), {
      answers: FORBIDDEN_CLOSES.map(() => "range"),
      closed: { code: 4000, reason: "ok" },
    })
    assertEquals(await closeWithoutCode(running.port), { code: 1000, reason: "" })
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

Deno.test("close is given the server's own close when the server closed first", async () => {
  const app = server({ wsMaxPayloadBytes: REPORT_CAP }).use(websocket())
  const next = closeReportRoute(app)
  const running = await serve(app, { hostname: "127.0.0.1", port: 0 })
  try {
    assertEquals(await closeReports(running.port, next), [...SERVER_CLOSE_REPORTS])
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

Deno.test("a socket registered after a guard refuses a handshake without credentials", async () => {
  const app = server()
    .use(websocket())
    .beforeHandle((c) =>
      c.req.headers.get("authorization") === "Bearer good"
        ? undefined
        : status(401, { error: "no" }),
    )
    .ws("/socket", {})
  const running = await serve(app, { hostname: "127.0.0.1", port: 0 })
  try {
    assertEquals(await rawUpgradeStatus(running.port, "/socket"), 401)
    assertEquals(
      await rawUpgradeStatus(running.port, "/socket", { authorization: "Bearer good" }),
      101,
    )
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

Deno.test("a WS-free app serves HTTP normally even when the client sends an Upgrade header", async () => {
  const app = server().get("/health", () => ({ ok: true }))
  const running = await serve(app, { hostname: "127.0.0.1", port: 0 })
  try {
    const res = await fetch(`http://127.0.0.1:${running.port}/health`, {
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
  const running = await serve(app, { hostname: "127.0.0.1", port: 0 })
  try {
    const base = `http://127.0.0.1:${running.port}`
    const res = await fetch(`${base}/json`)
    assertEquals(res.status, 200)
    assertEquals(res.headers.get("x-request-id"), "rid-1")
    assertEquals(res.headers.get("x-sec"), "nosniff")
    assertEquals(res.headers.get("x-status-seen"), "200")
    assertEquals(res.headers.get("x-multi"), "one, two")
    assertEquals(res.headers.get("content-type"), "application/json")
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
    const running = await serve(app, { hostname: "127.0.0.1", port: 0 })
    try {
      const out: unknown[] = []
      for (const path of paths) {
        const res = await fetch(`http://127.0.0.1:${running.port}${path}`)
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

/** One HTTP/1.1 request written straight to the socket, so the method token reaches the server
 * exactly as typed (`fetch` would normalise it). Returns the response status line. */
async function rawStatusLine(port: number, method: string, path: string): Promise<string> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port })
  try {
    const body = "x".repeat(32)
    await conn.write(
      new TextEncoder().encode(
        `${method} ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n` +
          `Content-Type: text/plain\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
      ),
    )
    const chunk = new Uint8Array(1024)
    const read = await conn.read(chunk)
    return new TextDecoder().decode(chunk.subarray(0, read ?? 0)).split("\r\n")[0] ?? ""
  } finally {
    conn.close()
  }
}

Deno.test("a method token that differs only in case is a different method on the wire", async () => {
  const hookSaw: string[] = []
  const handlerSaw: string[] = []
  const app = server()
    .onRequest((req) => {
      hookSaw.push(req.method)
    })
    .post("/mutate", (c) => {
      handlerSaw.push(c.req.method)
      return { ok: true }
    })
    .patch("/mutate/:id", (c) => {
      handlerSaw.push(c.req.method)
      return { ok: true }
    })
    .mountFetch("/legacy", (req) => {
      handlerSaw.push(`mount:${req.method}`)
      return Response.json({ ok: true })
    })
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  try {
    assertEquals(await rawStatusLine(running.port, "POST", "/mutate"), "HTTP/1.1 200 OK")
    assertEquals(await rawStatusLine(running.port, "PATCH", "/mutate/1"), "HTTP/1.1 200 OK")
    // This runtime hands the token over as sent. Anything but the exact registered token must stop
    // at routing: no hook, handler or mount may observe a method string a method check would not match.
    for (const method of ["post", "Post", "pOST"]) {
      assertEquals(
        await rawStatusLine(running.port, method, "/legacy/item"),
        "HTTP/1.1 404 Not Found",
      )
    }
    for (const [method, path] of [
      ["post", "/mutate"],
      ["Post", "/mutate"],
      ["pOST", "/mutate"],
      ["patch", "/mutate/1"],
      ["Patch", "/mutate/1"],
    ] as const) {
      assertEquals(
        await rawStatusLine(running.port, method, path),
        "HTTP/1.1 405 Method Not Allowed",
      )
    }
    assertEquals(hookSaw, ["POST", "PATCH"])
    assertEquals(handlerSaw, ["POST", "PATCH"])
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

// Deno hands the adapter the target exactly as sent; the app routes the path a URL parser resolves
// it to, as it does on every other runtime.
Deno.test("a target with dot segments or a backslash routes the path it resolves to", async () => {
  const running = await serve(requestTargetApp(server()), { port: 0, hostname: "127.0.0.1" })
  try {
    assertEquals(await requestTargetMismatches(running.port), [])
    assertEquals(await requestTargetMismatches(running.port, true), [])
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

// Deno builds the request URL from the Host as received: `Host: x/users/7#` with `GET /posts` was
// routed to `/users/:id`. Such a Host is refused, as Node refuses it.
Deno.test("a Host that is not an authority never steers the routed path", async () => {
  const running = await serve(requestTargetApp(server()), { port: 0, hostname: "127.0.0.1" })
  try {
    assertEquals(await invalidHostMismatches(running.port), [])
    assertEquals(await refusedHostMismatches(running.port), [])
    const refused = await rawExchange(running.port, "GET", "/posts", undefined, "x/users/7#")
    assertEquals(refused, { status: 400, body: '{"ok":false,"error":"invalid_host"}' })
    for (const host of ["127.0.0.1:8080", "[::1]:80", "my_svc.local"]) {
      const served = await rawExchange(running.port, "GET", "/posts", undefined, host)
      assertEquals(served, { status: 200, body: '{"route":"GET /posts"}' })
    }
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

// No URL can be built on a port past 65535, so resolving the dot segment threw out of `fetch` and the
// adapter answered 500. Found by the runtime differential (scripts/check-runtime-differential.ts).
Deno.test("a Host port past 65535 is refused, dot segments or not", async () => {
  const running = await serve(requestTargetApp(server()), { port: 0, hostname: "127.0.0.1" })
  try {
    for (const target of ["/posts", "/users/../posts"]) {
      const refused = await rawExchange(running.port, "GET", target, undefined, "127.0.0.1:99999")
      assertEquals(refused, { status: 400, body: '{"ok":false,"error":"invalid_host"}' })
    }
    const served = await rawExchange(
      running.port,
      "GET",
      "/users/../posts",
      undefined,
      "127.0.0.1:65535",
    )
    assertEquals(served, { status: 200, body: '{"route":"GET /posts"}' })
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

// The `Request` constructor refuses a TRACE, CONNECT or TRACK, and a lower-case `get` with a body, so
// rebuilding one to resolve its dot segments threw out of `fetch` and the adapter answered 500 where
// Bun and Node route it. Found by scripts/check-runtime-differential.ts.
Deno.test("a request no Request can be rebuilt from is routed on its resolved target", async () => {
  const running = await serve(requestTargetApp(server()), { port: 0, hostname: "127.0.0.1" })
  try {
    const answers = []
    for (const [method, target, body] of [
      ["TRACE", "/users/../posts", undefined],
      ["TRACK", "/./nowhere", undefined],
      ["get", "/users/../posts", "{}"],
    ] as const) {
      answers.push((await rawExchange(running.port, method, target, body)).status)
    }
    assertEquals(answers, [405, 404, 405])
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

const named: StandardSchemaV1<unknown, { name: string }> = {
  "~standard": {
    version: 1,
    vendor: "deno-test",
    validate: (value) =>
      typeof value === "object" &&
      value !== null &&
      "name" in value &&
      typeof value.name === "string"
        ? { value: { name: value.name } }
        : { issues: [{ message: "expected { name: string }" }] },
  },
}

// `Deno.serve`'s `Request.json()` keeps a leading byte order mark that every other runtime's drops, so a
// body schema refused what Bun and workerd parse. Found by scripts/check-runtime-differential.ts.
Deno.test("a JSON body led by a byte order mark parses through a schema and c.boundedJson", async () => {
  const app = server()
    .post("/named", { body: named }, (c) => c.body)
    .post("/bounded", (c) => c.boundedJson())
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  try {
    const body = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"name":"Ada"}')])
    for (const path of ["/named", "/bounded"]) {
      const res = await fetch(`http://127.0.0.1:${running.port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
      assertEquals([path, res.status, await res.json()], [path, 200, { name: "Ada" }])
    }
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

Deno.test("runtime-framed JSON text keeps validation, poisoning and byte limits", async () => {
  const app = server({ maxBodyBytes: 32 }).post("/named", { body: named }, (c) => c.body)
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  try {
    const url = `http://127.0.0.1:${running.port}/named`
    const post = (body: string) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
    const unicode = await post('{"name":"é😀"}')
    assertEquals([unicode.status, await unicode.json()], [200, { name: "é😀" }])
    const malformed = await post('{"name":')
    assertEquals(malformed.status, 400)
    const poisoned = await post('{"name":"Ada","__proto__":{}}')
    assertEquals(poisoned.status, 400)
    const over = await post(JSON.stringify({ name: "a".repeat(40) }))
    assertEquals(over.status, 413)

    // An in-process request is not runtime-framed: a forged short length cannot bypass the cap.
    const forged = await app.fetch(
      new Request("http://localhost/named", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "2" },
        body: JSON.stringify({ name: "a".repeat(40) }),
      }),
    )
    assertEquals(forged.status, 413)
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

Deno.test("an untouched runtime-framed JSON request uses the BOM-safe text reader", async () => {
  const app = server().post("/named", { body: named }, (c) => c.body)
  const body = '{"name":"Ada"}'
  const request = new Request("http://localhost/named", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(body.length) },
    body,
  })
  ;(request as unknown as Record<symbol, unknown>)[Symbol.for("nifra.body.trustedFraming")] = true
  const originalText = request.text.bind(request)
  let reads = 0
  request.text = () => {
    reads++
    return originalText()
  }
  const response = await app.fetch(request)
  assertEquals([response.status, await response.json(), reads], [200, { name: "Ada" }, 1])
})

// The framework's own 404 and 422 said `application/json;charset=utf-8`, Bun's spelling baked into core,
// while a handler's JSON and a 405 said Deno's `application/json`. Found by
// scripts/check-runtime-differential.ts.
Deno.test("a handler's JSON and the framework's envelopes carry the Content-Type Response.json writes", async () => {
  const app = server()
    .get("/ok", () => ({ ok: true }))
    .post("/users", { body: named }, (c) => c.body)
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  try {
    const base = `http://127.0.0.1:${running.port}`
    const answers = [
      await fetch(`${base}/ok`),
      await fetch(`${base}/missing`),
      await fetch(`${base}/ok`, { method: "DELETE" }),
      await fetch(`${base}/users`, {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
    ]
    const types = []
    for (const answer of answers) {
      types.push([answer.status, answer.headers.get("content-type")])
      await answer.body?.cancel()
    }
    const native = Response.json(0).headers.get("content-type")
    assertEquals(types, [
      [200, native],
      [404, native],
      [405, native],
      [422, native],
    ])
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

// Deno's own cache slot for a request's `Headers`, read so a release that renames it fails here.
function headersCacheSlot(): symbol {
  const slot = Object.getOwnPropertySymbols(new Request("http://localhost/")).find(
    (key) => key.description === "headers cache",
  )
  if (slot === undefined) throw new Error("this Deno has no `headers cache` slot on a Request")
  return slot
}

// The Host check, the upgrade probe and the JSON body lane read single headers: going through
// `req.headers` makes Deno build every header of the request, which cost a route that reads none ~4%
// of its throughput. The socket route makes the adapter probe every plain request for an upgrade.
Deno.test("the Host check, upgrade probe and JSON body lane leave the header list unbuilt", async () => {
  const headersCache = headersCacheSlot()
  const seen: Request[] = []
  const app = server()
    .use(websocket())
    .ws("/socket", { message: (ws, data) => ws.send(data) })
    .get("/bare", (c) => {
      seen.push(c.req)
      return { ok: true }
    })
    .post("/users", { body: named }, (c) => {
      seen.push(c.req)
      return { name: c.body.name }
    })
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  try {
    const base = `http://127.0.0.1:${running.port}`
    assertEquals(await (await fetch(`${base}/bare`)).json(), { ok: true })
    const created = await fetch(`${base}/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"name":"Ada"}',
    })
    assertEquals(await created.json(), { name: "Ada" })
    assertEquals(seen.length, 2)
    for (const request of seen) {
      assertEquals(Reflect.get(request, headersCache), undefined)
    }
    const refused = await rawExchange(running.port, "GET", "/nope", undefined, "x/bare#")
    assertEquals(refused, { status: 400, body: '{"ok":false,"error":"invalid_host"}' })
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

// A request a hook rebuilt carries the hook's headers, not the ones that arrived on the wire.
Deno.test("the body lane reads the headers of a request a hook rebuilt", async () => {
  const app = server()
    .onRequest((req) =>
      req.headers.get("x-body") === "json"
        ? new Request(req, { headers: { "content-type": "application/json" } })
        : undefined,
    )
    .post("/users", { body: named }, (c) => ({ name: c.body.name }))
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  try {
    const created = await fetch(`http://127.0.0.1:${running.port}/users`, {
      method: "POST",
      headers: { "content-type": "text/plain", "x-body": "json" },
      body: '{"name":"Ada"}',
    })
    assertEquals(created.status, 200)
    assertEquals(await created.json(), { name: "Ada" })
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

// A request Deno did not parse off the wire has no single-header reader; its Host is still checked.
Deno.test("a constructed request's Host is checked through its headers", async () => {
  const app = requestTargetApp(server())
  const refused = await app.fetch(
    new Request("http://127.0.0.1/posts", { headers: { host: "x/users/7#" } }),
  )
  assertEquals(refused.status, 400)
  assertEquals(await refused.json(), { ok: false, error: "invalid_host" })
  const served = await app.fetch(
    new Request("http://127.0.0.1/posts", { headers: { host: "127.0.0.1:8080" } }),
  )
  assertEquals(await served.json(), { route: "GET /posts" })
})

Deno.test("a handshake whose Host is not an authority is refused", async () => {
  const app = server()
    .use(websocket())
    .ws("/echo", { message: (ws, data) => ws.send(data) })
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  try {
    assertEquals(await rawUpgradeStatus(running.port, "/nope", {}, "127.0.0.1/echo#"), 400)
    assertEquals(await rawUpgradeStatus(running.port, "/echo", {}, "127.0.0.1:8080"), 101)
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

Deno.test("a handshake target with dot segments upgrades on the path it resolves to", async () => {
  const app = server()
    .use(websocket())
    .ws("/echo", { message: (ws, data) => ws.send(data) })
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  try {
    assertEquals(await rawUpgradeStatus(running.port, "/rooms/../echo"), 101)
    assertEquals(await rawUpgradeStatus(running.port, "/rooms/%2e%2e/echo"), 101)
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

Deno.test("tls serves HTTPS from PEM bytes, and request URLs see https:", async () => {
  const { cert, key } = await selfSignedCertificate()
  const app = server().get("/where", (c) => ({ url: c.req.url }))
  const bytes = new TextEncoder()
  const running = await serve(app, {
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert: bytes.encode(cert), key: bytes.encode(key) },
  })
  // The certificate is self-signed, so the client trusts it explicitly.
  const client = Deno.createHttpClient({ caCerts: [cert] })
  try {
    const base = `https://127.0.0.1:${running.port}`
    assertEquals(await (await fetch(`${base}/where`, { client })).json(), { url: `${base}/where` })
  } finally {
    client.close()
    await running.stop({ drainMs: 0 })
  }
})

Deno.test("serves a QUERY route: its body validated, its method kept, GET beside it", async () => {
  const app = server()
    .get("/search", () => ({ via: "get" }))
    .use(
      method("QUERY", "/search", { body: named }, (c) => ({
        via: c.req.method,
        name: c.body.name,
      })),
    )
  const running = await serve(app, { hostname: "127.0.0.1", port: 0 })
  try {
    const url = `http://127.0.0.1:${running.port}/search`
    const query = (body: string) =>
      fetch(url, { method: "QUERY", headers: { "content-type": "application/json" }, body })
    const found = await query('{"name":"nifra"}')
    assertEquals([found.status, await found.json()], [200, { via: "QUERY", name: "nifra" }])
    const invalid = await query('{"name":1}')
    assertEquals(invalid.status, 422)
    await invalid.body?.cancel()
    assertEquals(await (await fetch(url)).json(), { via: "get" })
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

/** Answers `/robots.txt` at once and `/later` after a tick; leaves `/pending` and the rest to the app. */
function robotsFirst(request: Request): Response | Promise<Response | undefined> | undefined {
  const { pathname } = new URL(request.url)
  if (pathname === "/robots.txt") return new Response("file")
  if (pathname === "/later") return Promise.resolve(new Response("file later"))
  if (pathname === "/pending") return Promise.resolve(undefined)
  if (pathname === "/sync-throw") throw new Error("disk gone")
  if (pathname === "/async-throw") return Promise.reject(new Error("disk gone"))
  return undefined
}

Deno.test("static answers before any route, hands undefined to the app, and runs no app hook", async () => {
  const hooked: string[] = []
  const app = server()
    .onRequest((request) => {
      hooked.push(new URL(request.url).pathname)
    })
    .get("/:slug", (c) => ({ slug: c.params.slug }))
  const running = await serve(app, { hostname: "127.0.0.1", port: 0, static: robotsFirst })
  try {
    const base = `http://127.0.0.1:${running.port}`
    const answers: string[] = []
    for (const path of ["/robots.txt", "/later", "/pending", "/about"]) {
      const res = await fetch(base + path)
      answers.push(`${res.status} ${await res.text()}`)
    }
    assertEquals(answers, [
      "200 file",
      "200 file later",
      '200 {"slug":"pending"}',
      '200 {"slug":"about"}',
    ])
    assertEquals(hooked, ["/pending", "/about"])
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

Deno.test("static fronts an app with WebSocket routes, which still upgrade", async () => {
  const app = server()
    .use(websocket())
    .ws("/echo", { open: (ws) => ws.send("welcome") })
    .get("/:slug", (c) => ({ slug: c.params.slug }))
  const running = await serve(app, { hostname: "127.0.0.1", port: 0, static: robotsFirst })
  try {
    assertEquals(await (await fetch(`http://127.0.0.1:${running.port}/robots.txt`)).text(), "file")
    const first = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${running.port}/echo`)
      const timer = setTimeout(() => reject(new Error("ws timed out")), 5000)
      socket.onmessage = (ev) => {
        clearTimeout(timer)
        socket.close()
        resolve(String(ev.data))
      }
      socket.onerror = () => {
        clearTimeout(timer)
        reject(new Error("ws error"))
      }
    })
    assertEquals(first, "welcome")
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

Deno.test("a static handler that throws or rejects answers a flat 500", async () => {
  const app = server().get("/:slug", (c) => ({ slug: c.params.slug }))
  const running = await serve(app, { hostname: "127.0.0.1", port: 0, static: robotsFirst })
  try {
    for (const path of ["/sync-throw", "/async-throw"]) {
      const res = await fetch(`http://127.0.0.1:${running.port}${path}`)
      assertEquals(res.status, 500)
      assertEquals(await res.json(), { ok: false, error: "internal_error" })
    }
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

Deno.test("stop() drains a static response in flight", async () => {
  let entered = (): void => {}
  const inFlight = new Promise<void>((resolve) => {
    entered = resolve
  })
  const app = server().get("/", () => "app")
  const running = await serve(app, {
    hostname: "127.0.0.1",
    port: 0,
    static: (request) => {
      if (new URL(request.url).pathname !== "/slow") return undefined
      entered()
      return new Promise((resolve) => setTimeout(() => resolve(new Response("slow file")), 80))
    },
  })
  const pending = fetch(`http://127.0.0.1:${running.port}/slow`)
    .then((r) => r.text())
    .catch(() => "ERR")
  // A request the handler never saw reaches the app's 404 and fails here instead of hanging.
  await Promise.race([
    inFlight,
    pending.then(() => {
      throw new Error("the static handler never saw /slow")
    }),
  ])
  await running.stop({ drainMs: 1000 })
  assertEquals(await pending, "slow file")
})
