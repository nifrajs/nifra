import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { prettyJson } from "../src/index.ts"

describe("prettyJson()", () => {
  test("pretty-prints JSON responses", async () => {
    const app = server()
      .use(prettyJson({ spaces: 2, newline: false }))
      .get("/", () => ({ a: 1, b: { c: 2 } }))

    const res = await app.fetch(new Request("http://x/"))
    expect(await res.text()).toBe('{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}')
  })

  test("supports an explicit query toggle", async () => {
    const app = server()
      .use(prettyJson({ query: "pretty" }))
      .get("/", () => ({ a: 1 }))

    expect(await (await app.fetch(new Request("http://x/"))).text()).toBe('{"a":1}')
    expect(await (await app.fetch(new Request("http://x/?pretty"))).text()).toBe('{\n  "a": 1\n}\n')
  })

  test("leaves non-json, encoded, invalid, and oversized responses untouched", async () => {
    const app = server()
      .use(prettyJson({ maxBytes: 4 }))
      .get("/text", () => new Response("hello", { headers: { "content-type": "text/plain" } }))
      .get(
        "/encoded",
        () =>
          new Response('{"a":1}', {
            headers: { "content-type": "application/json", "content-encoding": "gzip" },
          }),
      )
      .get(
        "/invalid",
        () => new Response("nope", { headers: { "content-type": "application/json" } }),
      )
      .get(
        "/large",
        () =>
          new Response('{"abcdef":1}', {
            headers: { "content-type": "application/json", "content-length": "12" },
          }),
      )

    expect(await (await app.fetch(new Request("http://x/text"))).text()).toBe("hello")
    expect(await (await app.fetch(new Request("http://x/encoded"))).text()).toBe('{"a":1}')
    expect(await (await app.fetch(new Request("http://x/invalid"))).text()).toBe("nope")
    expect(await (await app.fetch(new Request("http://x/large"))).text()).toBe('{"abcdef":1}')
  })

  test("validates construction", () => {
    expect(() => prettyJson({ spaces: -1 })).toThrow(/spaces/)
    expect(() => prettyJson({ spaces: 11 })).toThrow(/spaces/)
    expect(() => prettyJson({ maxBytes: -1 })).toThrow(/maxBytes/)
    expect(() => prettyJson({ query: "" })).toThrow(/query/)
  })
})

// A streamed response has no content-length to check up front, so the byte cap and the read-failure
// path are the only things standing between a cosmetic feature and a response it breaks. Both must
// abandon the rewrite and hand back the ORIGINAL response.
describe("prettyJson() streaming safety", () => {
  const streamed = (chunks: readonly string[]): Response =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
          controller.close()
        },
      }),
      { headers: { "content-type": "application/json" } },
    )

  test("a streamed body past maxBytes is passed through, not truncated", async () => {
    // The cap is reached mid-stream, where the early content-length check cannot help. Returning a
    // half-read document as if it were the response is the one outcome worth preventing.
    const payload = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => i) })
    const app = server()
      .use(prettyJson({ maxBytes: 16 }))
      .get("/", () => streamed([payload.slice(0, 32), payload.slice(32)]))

    const res = await app.fetch(new Request("http://x/"))
    expect(await res.text()).toBe(payload)
  })

  test("a body that fails mid-read is passed through rather than throwing", async () => {
    const app = server()
      .use(prettyJson())
      .get(
        "/",
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"a":'))
                controller.error(new Error("connection reset"))
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
      )

    // The read fails, so there is nothing to prettify - the middleware must not turn that into a 500.
    const res = await app.fetch(new Request("http://x/"))
    expect(res.status).toBe(200)
  })
})

test("a client that disconnects mid-passthrough cancels the upstream body", async () => {
  // The oversized path hands back a stream that replays what was already pulled and then continues
  // from the same reader. If cancelling that stream did not propagate, the upstream body would be
  // left producing into nothing for the rest of its life.
  let cancelled: unknown
  const app = server()
    .use(prettyJson({ maxBytes: 4 }))
    .get(
      "/",
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"a":"aaaaaaaaaa"}'))
            },
            cancel(reason) {
              cancelled = reason
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    )

  const res = await app.fetch(new Request("http://x/"))
  await res.body?.cancel("client went away")
  expect(cancelled).toBe("client went away")
})
