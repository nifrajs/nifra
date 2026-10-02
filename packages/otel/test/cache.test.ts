import { describe, expect, test } from "bun:test"
import { createCache } from "@nifrajs/cache"
import { server } from "@nifrajs/core/server"
import { type CacheTracingEvent, cacheTracing } from "../src/cache.ts"
import type { NifraSpan } from "../src/span.ts"
import { tracing } from "../src/tracing.ts"

const flush = (): Promise<void> => Bun.sleep(2)

function collect(): { spans: NifraSpan[]; exporter: { onEnd(span: NifraSpan): void } } {
  const spans: NifraSpan[] = []
  return { spans, exporter: { onEnd: (span) => spans.push(span) } }
}

function present<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing ${what}`)
  return value
}

const TRACE = {
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  sampled: true,
  traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
}

function event(overrides: Partial<CacheTracingEvent> = {}): CacheTracingEvent {
  return {
    op: "get",
    outcome: "hit",
    startedAt: 1_700_000_000_000,
    durationMs: 1.5,
    key: undefined,
    tag: undefined,
    tagCount: 0,
    context: { trace: TRACE },
    ...overrides,
  }
}

describe("cacheTracing", () => {
  test("a bound wrap inside a traced request becomes a child span with its outcome", async () => {
    const { spans, exporter } = collect()
    const cache = createCache({ observer: cacheTracing({ exporter }) })
    const app = server()
      .use(tracing({ exporter }))
      .get("/orders", async (c) => ({
        orders: await cache.for(c).wrap("orders:alice@example.com", () => [1, 2], { tags: ["o"] }),
      }))

    await app.fetch(new Request("http://nifra.test/orders"))
    await app.fetch(new Request("http://nifra.test/orders"))

    const request = spans.filter((span) => span.name === "GET /orders")
    const wraps = spans.filter((span) => span.name === "cache wrap")
    expect(request).toHaveLength(2)
    expect(wraps.map((span) => span.attributes["nifra.cache.outcome"])).toEqual(["miss", "hit"])
    for (const [index, span] of wraps.entries()) {
      expect(span.kind).toBe("internal")
      expect(span.status).toBe("ok")
      expect(request[index]?.traceId).toBe(span.traceId)
      expect(request[index]?.spanId).toBe(span.parentSpanId)
      expect(span.attributes).toMatchObject({
        "nifra.cache.operation": "wrap",
        "nifra.cache.key_prefix": "orders",
        "nifra.cache.tag_count": 1,
      })
    }
    expect(JSON.stringify(spans)).not.toContain("alice")
  })

  test("a stale wrap's background refresh is its own trace, linked to the request span", async () => {
    let at = 1_000_000
    const { spans, exporter } = collect()
    const cache = createCache({ now: () => at, observer: cacheTracing({ exporter }) })
    await cache.set("user:1", "old", { ttlMs: 10, swrMs: 1000 })
    at += 20
    const app = server()
      .use(tracing({ exporter }))
      .get("/u", async (c) => ({ user: await cache.for(c).wrap("user:1", () => "new") }))

    await app.fetch(new Request("http://nifra.test/u"))
    await flush()

    const request = present(
      spans.find((span) => span.name === "GET /u"),
      "the request span",
    )
    const revalidate = present(
      spans.find((span) => span.name === "cache revalidate"),
      "the revalidate span",
    )
    expect(
      spans.find((span) => span.name === "cache wrap")?.attributes["nifra.cache.outcome"],
    ).toBe("stale")
    expect(revalidate.parentSpanId).toBeUndefined()
    expect(revalidate.traceId).not.toBe(request.traceId)
    expect(revalidate.links).toEqual([{ traceId: request.traceId, spanId: request.spanId }])
  })

  test("the unbound cache, a context without a trace and a malformed traceparent are not traced", () => {
    const { spans, exporter } = collect()
    const observe = cacheTracing({ exporter })
    observe(event({ context: undefined }))
    observe(event({ context: {} }))
    observe(event({ context: { trace: "nope" } }))
    observe(event({ context: { trace: { traceparent: 42 } } }))
    observe(event({ context: { trace: { ...TRACE, traceparent: "00-zz-yy-01" } } }))
    expect(spans).toHaveLength(0)
  })

  test("the span carries the event's own timing, and an error outcome is an error span", () => {
    const { spans, exporter } = collect()
    cacheTracing({ exporter })(event({ op: "set", outcome: "error", key: "k" }))
    expect(spans[0]).toMatchObject({
      name: "cache set",
      startTime: 1_700_000_000_000,
      endTime: 1_700_000_000_001.5,
      durationMs: 1.5,
      status: "error",
      traceId: TRACE.traceId,
      parentSpanId: TRACE.spanId,
      sampled: true,
    })
  })

  test("an unsampled parent yields an unsampled span", () => {
    const { spans, exporter } = collect()
    cacheTracing({ exporter })(
      event({
        context: {
          trace: { ...TRACE, traceparent: TRACE.traceparent.replace(/-01$/, "-00") },
        },
      }),
    )
    expect(spans[0]?.sampled).toBe(false)
  })

  test("key prefix rules: lowercase token before the first colon, at most 32 characters", () => {
    const { spans, exporter } = collect()
    const observe = cacheTracing({ exporter })
    const keys = [
      "user:42",
      "user_v2-x:a:b",
      "User:42",
      "nocolon",
      ":leading",
      "9lives:x",
      `${"a".repeat(32)}:x`,
      `${"a".repeat(33)}:x`,
      "us er:x",
    ]
    for (const key of keys) observe(event({ key }))
    expect(spans.map((span) => span.attributes["nifra.cache.key_prefix"])).toEqual([
      "user",
      "user_v2-x",
      undefined,
      undefined,
      undefined,
      undefined,
      "a".repeat(32),
      undefined,
      undefined,
    ])
    observe(event({ op: "invalidateTag", tag: "user:42", tagCount: 1 }))
    expect(spans.at(-1)?.attributes["nifra.cache.tag_prefix"]).toBe("user")
    expect(JSON.stringify(spans)).not.toContain(":42")
  })

  test("keyAttribute none exports nothing; a function exports its result and owns redaction", () => {
    const none = collect()
    cacheTracing({ exporter: none.exporter, keyAttribute: "none" })(event({ key: "user:1" }))
    expect(Object.keys(none.spans[0]?.attributes ?? {})).toEqual([
      "nifra.cache.operation",
      "nifra.cache.outcome",
      "nifra.cache.tag_count",
    ])

    const mapped = collect()
    const observe = cacheTracing({
      exporter: mapped.exporter,
      keyAttribute: (key) => {
        if (key === "throw") throw new Error("mapper bug")
        return key.startsWith("skip") ? undefined : `h:${key.length}`
      },
    })
    observe(event({ key: "user:1" }))
    observe(event({ key: "skip:1" }))
    observe(event({ key: "throw" }))
    observe(event({ op: "invalidateTag", tag: "team:7", tagCount: 1 }))
    expect(mapped.spans.map((span) => span.attributes["nifra.cache.key"])).toEqual([
      "h:6",
      undefined,
      undefined,
      undefined,
    ])
    expect(mapped.spans[3]?.attributes["nifra.cache.tag"]).toBe("h:6")
    expect(mapped.spans).toHaveLength(4)
  })
})
