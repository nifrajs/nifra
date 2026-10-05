import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { type ClientOptions, client } from "@nifrajs/client"
import { type RunningServer, server } from "@nifrajs/core"

/** Headers and a first chunk go out at once and the rest never comes, so the body read is what fails. */
function stalled(contentType: string, first: string): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(new TextEncoder().encode(first)),
      pull: () => new Promise<void>(() => {}),
    }),
    { headers: { "content-type": contentType } },
  )
}

const app = server()
  .get("/json", () => stalled("application/json", '{"items":['))
  .get("/text", () => stalled("text/plain", "partial"))
  .get("/binary", () => stalled("application/octet-stream", "\u0000\u0001"))

let running: RunningServer
beforeAll(() => {
  running = app.listen(0, { hostname: "127.0.0.1" })
})
afterAll(() => running.stop(true))

function read(route: "json" | "text" | "binary", options: ClientOptions, signal?: AbortSignal) {
  const api = client<typeof app>(`http://127.0.0.1:${running.port}`, options)
  const call = signal === undefined ? undefined : { signal }
  if (route === "json") return api.json.get(call)
  if (route === "text") return api.text.get(call)
  return api.binary.get(call)
}

describe("a body that stops arriving after its headers", () => {
  test.each([
    "json",
    "text",
    "binary",
  ] as const)("%s: the call's deadline is a timeout Result", async (route) => {
    expect(await read(route, { timeoutMs: 100 })).toEqual({
      ok: false,
      status: 0,
      data: null,
      error: { error: "timeout" },
    })
  })

  test.each([
    "json",
    "text",
    "binary",
  ] as const)("%s: the caller's abort is a Result", async (route) => {
    const controller = new AbortController()
    const result = await read(
      route,
      {
        onResponse: () => {
          controller.abort()
        },
      },
      controller.signal,
    )
    expect(result).toEqual({ ok: false, status: 0, data: null, error: { error: "network_error" } })
  })
})
