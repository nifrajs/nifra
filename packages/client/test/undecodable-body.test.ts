import { describe, expect, test } from "bun:test"
import { client, inProcessClient } from "@nifrajs/client"
import { server } from "@nifrajs/core"

const shape = server().get("/x", (): unknown => null)

const answering = (body: string, status: number, contentType: string) =>
  client<typeof shape>("http://example.test", {
    fetch: async () => new Response(body, { status, headers: { "content-type": contentType } }),
  })

describe("a body its content type does not decode", () => {
  test("a proxy's HTML error page labelled JSON is a Result, not a throw", async () => {
    const api = answering("<html>bad gateway</html>", 502, "application/json")
    expect(await api.x.get()).toEqual({
      ok: false,
      status: 0,
      data: null,
      error: { error: "malformed_response" },
    })
  })

  test("the in-process client answers the same Result", async () => {
    const app = server().get(
      "/x",
      () =>
        new Response("<html>bad gateway</html>", {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
    )
    expect(await inProcessClient(app).x.get()).toEqual({
      ok: false,
      status: 0,
      data: null,
      error: { error: "malformed_response" },
    })
  })

  test("a nifra media type with no codec registered is a Result", async () => {
    const api = answering("{}", 200, "application/vnd.nifra.unknown")
    expect(await api.x.get()).toEqual({
      ok: false,
      status: 0,
      data: null,
      error: { error: "malformed_response" },
    })
  })
})

describe("a media type that only shares the application/json prefix", () => {
  test("application/json-patch+json is parsed as JSON", async () => {
    const api = answering(
      '[{"op":"add","path":"/a","value":1}]',
      200,
      "application/json-patch+json",
    )
    expect(await api.x.get()).toEqual({
      ok: true,
      status: 200,
      data: [{ op: "add", path: "/a", value: 1 }],
      error: null,
    })
  })

  test("application/jsonl comes back as its text", async () => {
    const api = answering('{"a":1}\n{"a":2}', 200, "application/jsonl")
    expect(await api.x.get()).toEqual({
      ok: true,
      status: 200,
      data: '{"a":1}\n{"a":2}',
      error: null,
    })
  })

  test("application/json with parameters still goes through the JSON codec", async () => {
    const api = answering('{"a":1}', 200, "application/json ; charset=utf-8")
    expect(await api.x.get()).toEqual({ ok: true, status: 200, data: { a: 1 }, error: null })
  })
})
