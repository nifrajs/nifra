import { server } from "@nifrajs/core"
import { serve } from "../src/index.ts"

// Minimal local assertions — keeps `deno test` offline + dependency-free.
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
    // Respect the abort signal so the handler's timer clears on timeout — otherwise
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
  // This suite runs under Deno, where `Bun` is undefined — so listen()'s guard fires.
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
