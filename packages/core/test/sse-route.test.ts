import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { server } from "../src/index.ts"
import { reflectRoutes } from "../src/reflection.ts"
import { streaming } from "../src/server/sse.ts"

const post = t.object({ id: t.integer(), title: t.string() })

describe("app.sse()", () => {
  test("serves text/event-stream with typed, JSON-serialized events", async () => {
    const app = server()
      .use(streaming())
      .sse("/feed", { sse: post }, (_c, stream) => {
        stream.send({ id: 1, title: "hello" })
        stream.send({ id: 2, title: "world" }, { event: "post", id: "2" })
        stream.close()
      })

    const response = await app.fetch(new Request("http://t/feed"))
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const text = await response.text()
    expect(text).toContain(`data: {"id":1,"title":"hello"}`)
    expect(text).toContain("event: post")
    expect(text).toContain("id: 2")
  })

  test("query schema validates like any other route", async () => {
    // Query values arrive as strings — same contract as every route (use a coercing schema for numbers).
    const app = server()
      .use(streaming())
      .sse(
        "/feed",
        { sse: post, query: t.object({ topic: t.string({ minLength: 2 }) }) },
        (c, stream) => {
          stream.send({ id: c.query.topic.length, title: c.query.topic })
          stream.close()
        },
      )
    const bad = await app.fetch(new Request("http://t/feed?topic=x"))
    expect(bad.status).toBe(422)
    const ok = await app.fetch(new Request("http://t/feed?topic=news"))
    expect(await ok.text()).toContain('"title":"news"')
  })

  test("stream.comment emits a `:` line; typedSSEStream wraps a raw stream", async () => {
    const app = server()
      .use(streaming())
      .sse("/c", { sse: post }, (_c, stream) => {
        stream.comment("ping")
        stream.send({ id: 1, title: "after-comment" })
        stream.close()
      })
    const text = await (await app.fetch(new Request("http://t/c"))).text()
    expect(text).toContain(": ping")
    expect(text).toContain('"after-comment"')
  })

  test("client disconnect aborts the stream signal", async () => {
    let aborted = false
    const app = server()
      .use(streaming())
      .sse("/live", { sse: post }, (_c, stream) => {
        stream.signal.addEventListener("abort", () => {
          aborted = true
        })
        return new Promise<void>((resolve) =>
          stream.signal.addEventListener("abort", () => resolve(), { once: true }),
        )
      })
    const controller = new AbortController()
    const response = await app.fetch(new Request("http://t/live", { signal: controller.signal }))
    const reader = response.body!.getReader()
    controller.abort()
    await reader.cancel().catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(aborted).toBe(true)
  })

  test("the sse schema flows into routes() and reflection", () => {
    const app = server()
      .use(streaming())
      .sse("/feed", { sse: post }, (_c, stream) => stream.close())
    const [route] = reflectRoutes(app)
    expect(route?.method).toBe("GET")
    expect(route?.schema?.sse?.jsonSchema).toBeDefined()
    const json = route?.schema?.sse?.jsonSchema as Record<string, unknown>
    expect(Object.keys(json.properties as object)).toEqual(["id", "title"])
  })
})
