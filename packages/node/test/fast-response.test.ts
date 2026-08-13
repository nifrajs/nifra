import { afterAll, afterEach, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { type NodeServer, serve } from "../src/index.ts"

// `serve({ fastResponse: true })` swaps `globalThis.Response` for a stand-in that defers a simple
// `new Response(...)` onto the direct-write lane. The swap is process-global and intentionally not
// auto-restored, so this file puts the native `Response` back after its own run to keep other test
// files clean.
const NativeResponse = globalThis.Response

let running: NodeServer | undefined
afterEach(async () => {
  await running?.stop({ drainMs: 0 })
  running = undefined
})
afterAll(() => {
  globalThis.Response = NativeResponse
})

function rawResponseApp() {
  return (
    server()
      // The slow lane made fast: a hand-rolled string Response.
      .get("/ping", () => new Response("Hi"))
      .get("/status", () => new Response("made", { status: 201, headers: { "x-mark": "1" } }))
      // Non-simple bodies must still work unchanged - these take the real-Response path.
      .get("/empty", () => new Response(null, { status: 204 }))
      .get(
        "/stream",
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("streamed"))
                controller.close()
              },
            }),
            { headers: { "content-type": "text/plain" } },
          ),
      )
  )
}

test("fastResponse serves a hand-rolled string Response byte-for-byte, with content-length", async () => {
  running = await serve(rawResponseApp(), { port: 0, fastResponse: true })
  const res = await fetch(`http://localhost:${running.port}/ping`)
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toContain("text/plain")
  expect(res.headers.get("content-length")).toBe("2")
  expect(await res.text()).toBe("Hi")
})

test("fastResponse preserves an explicit status and header on a raw Response", async () => {
  running = await serve(rawResponseApp(), { port: 0, fastResponse: true })
  const res = await fetch(`http://localhost:${running.port}/status`)
  expect(res.status).toBe(201)
  expect(res.headers.get("x-mark")).toBe("1")
  expect(await res.text()).toBe("made")
})

test("fastResponse leaves non-simple Responses (204, streamed) unchanged", async () => {
  running = await serve(rawResponseApp(), { port: 0, fastResponse: true })
  const empty = await fetch(`http://localhost:${running.port}/empty`)
  expect(empty.status).toBe(204)
  expect(await empty.text()).toBe("")

  const streamed = await fetch(`http://localhost:${running.port}/stream`)
  expect(streamed.headers.get("content-type")).toContain("text/plain")
  expect(await streamed.text()).toBe("streamed")
})

test("the patched global Response still satisfies instanceof and the static helpers", () => {
  running = undefined
  // Install by starting (then stopping) a server, then probe the global directly.
  return serve(
    server().get("/", () => new Response("x")),
    { port: 0, fastResponse: true },
  ).then(async (s) => {
    try {
      const simple = new Response("Hi")
      expect(simple instanceof Response).toBe(true)
      expect(await simple.text()).toBe("Hi")
      // Static inherited from the native constructor.
      const j = Response.json({ ok: true })
      expect(j instanceof Response).toBe(true)
      expect(await j.json()).toEqual({ ok: true })
    } finally {
      await s.stop({ drainMs: 0 })
    }
  })
})
