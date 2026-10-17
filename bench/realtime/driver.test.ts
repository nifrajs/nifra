import { expect, test } from "bun:test"
import { sseThroughput } from "./driver.ts"

test("SSE integrity counts frames whose marker straddles network chunks", async () => {
  const encoder = new TextEncoder()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode("da"))
            setTimeout(() => {
              controller.enqueue(encoder.encode('ta: {"n":0}\n\ndata: {"n":1}\n\n'))
              controller.close()
            }, 20)
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  })
  try {
    expect((await sseThroughput(server.url.origin, 2)).events).toBe(2)
  } finally {
    server.stop(true)
  }
})

test("SSE integrity rejects truncated event counts and unsuccessful responses", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      new URL(request.url).searchParams.get("n") === "2"
        ? new Response('data: {"n":0}\n\n')
        : new Response("unavailable", { status: 503 }),
  })
  try {
    await expect(sseThroughput(server.url.origin, 2)).rejects.toThrow("SSE integrity")
    await expect(sseThroughput(server.url.origin, 3)).rejects.toThrow("SSE HTTP 503")
  } finally {
    server.stop(true)
  }
})
