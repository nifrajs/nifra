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
