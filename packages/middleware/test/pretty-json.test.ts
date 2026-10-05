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

  test("re-indents without rewriting a number or a string as written", async () => {
    const written = '{"id":12345678901234567890,"big":1e400,"neg":-0,"s":"caf\\u00e9 \\/ ok"}'
    const app = server()
      .use(prettyJson({ spaces: 2, newline: false }))
      .get("/", () => new Response(written, { headers: { "content-type": "application/json" } }))
      .get("/body", (c) => c.text(written, { headers: { "content-type": "application/json" } }))
    const expected =
      '{\n  "id": 12345678901234567890,\n  "big": 1e400,\n  "neg": -0,\n  "s": "caf\\u00e9 \\/ ok"\n}'
    expect(await (await app.fetch(new Request("http://x/"))).text()).toBe(expected)
    expect(await (await app.fetch(new Request("http://x/body"))).text()).toBe(expected)
  })

  test("lays out any document exactly as JSON.stringify would", async () => {
    const documents: unknown[] = [
      { a: [], b: {}, c: [[], [{}], { d: [1, { e: null }] }], f: 'x,y:{z}[]"' },
      [1, "two", true, false, null, -1.5e-7, { nested: { deeper: ["\\", "\u2028"] } }],
      "plain",
      42,
      [],
      {},
    ]
    for (const spaces of [0, 2, 4]) {
      for (const document of documents) {
        const app = server()
          .use(prettyJson({ spaces, newline: false }))
          .get(
            "/",
            () =>
              new Response(JSON.stringify(document, null, 3), {
                headers: { "content-type": "application/json" },
              }),
          )
        const text = await (await app.fetch(new Request("http://x/"))).text()
        expect(text).toBe(JSON.stringify(document, null, spaces))
      }
    }
  })

  test("supports an explicit query toggle", async () => {
    const app = server()
      .use(prettyJson({ query: "pretty" }))
      .get("/", () => ({ a: 1 }))

    expect(await (await app.fetch(new Request("http://x/"))).text()).toBe('{"a":1}')
    expect(await (await app.fetch(new Request("http://x/?pretty"))).text()).toBe('{\n  "a": 1\n}\n')
  })

  test("pretty-prints a raw streamed JSON response", async () => {
    const app = server()
      .use(prettyJson({ spaces: 2, newline: false }))
      .get(
        "/",
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"a":1,"b":2}'))
                controller.close()
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
      )
    const res = await app.fetch(new Request("http://x/"))
    expect(await res.text()).toBe('{\n  "a": 1,\n  "b": 2\n}')
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

  test("preserves invalid UTF-8 in a raw JSON response", async () => {
    const bytes = new Uint8Array([0x6e, 0x6f, 0x70, 0x65, 0xff])
    const app = server()
      .use(prettyJson())
      .get("/", () => new Response(bytes, { headers: { "content-type": "application/json" } }))

    const res = await app.fetch(new Request("http://x/"))
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)
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

  // The framework-serialized tier has the same two ways out as the raw one: a body too big to
  // hold, and bytes that are not actually JSON despite the content type.
  test("leaves a framework-serialized body alone once it exceeds maxBytes", async () => {
    const app = server()
      .use(prettyJson({ maxBytes: 8 }))
      .get("/", () => ({ a: 1, b: { c: 2 } }))
    const res = await app.fetch(new Request("http://x/"))
    expect(await res.text()).toBe('{"a":1,"b":{"c":2}}') // untouched, still compact
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
