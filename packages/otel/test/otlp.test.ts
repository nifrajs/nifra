import { describe, expect, test } from "bun:test"
import type { NifraSpan } from "../src/index.ts"
import { otlpExporter } from "../src/index.ts"

function span(overrides: Partial<NifraSpan> = {}): NifraSpan {
  return {
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    sampled: true,
    name: "GET /orders",
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_000_025,
    durationMs: 25,
    status: "ok",
    attributes: { "http.response.status_code": 200, "http.request.method": "GET", cached: true },
    ...overrides,
  }
}

/** A fetch stub that records each POST body. */
function recordingFetch() {
  const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = []
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({
      url,
      body: JSON.parse(String(init.body)),
      headers: init.headers as Record<string, string>,
    })
    return { ok: true, status: 200 }
  }
  return { calls, fetch }
}

describe("otlpExporter", () => {
  const invalidBatchNumbers = [
    ["zero", 0],
    ["negative", -1],
    ["non-integer", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ] as const
  const batchOptions = ["maxBatch", "maxQueue", "flushIntervalMs"] as const

  for (const option of batchOptions) {
    for (const [category, value] of invalidBatchNumbers) {
      test(`rejects ${category} batch.${option}`, () => {
        expect(() =>
          otlpExporter({
            url: "http://c",
            batch: { [option]: value },
          }),
        ).toThrow(`otlpExporter: batch.${option} must be a positive safe integer`)
      })
    }
  }

  test("maps a span onto the OTLP/JSON resourceSpans shape", async () => {
    const { calls, fetch } = recordingFetch()
    const exp = otlpExporter({
      url: "http://c/v1/traces",
      serviceName: "orders-api",
      headers: { authorization: "Bearer t" },
      fetch,
    })
    exp.onEnd(span())
    await exp.flush()

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("http://c/v1/traces")
    expect(calls[0]?.headers).toMatchObject({ authorization: "Bearer t" })
    const rs = (calls[0]?.body as { resourceSpans: unknown[] }).resourceSpans[0] as {
      resource: { attributes: Array<{ key: string; value: { stringValue: string } }> }
      scopeSpans: Array<{ spans: Array<Record<string, unknown>> }>
    }
    expect(rs.resource.attributes).toContainEqual({
      key: "service.name",
      value: { stringValue: "orders-api" },
    })
    const otlp = rs.scopeSpans[0]?.spans[0] as Record<string, unknown>
    expect(otlp.traceId).toBe("0af7651916cd43dd8448eb211c80319c")
    expect(otlp.spanId).toBe("b7ad6b7169203331")
    expect(otlp.kind).toBe(2)
    expect(otlp.startTimeUnixNano).toBe("1700000000000000000")
    expect(otlp.endTimeUnixNano).toBe("1700000000025000000")
    expect(otlp.status).toEqual({ code: 1 })
  })

  test("encodes attribute value types (int as string, bool, string)", async () => {
    const { calls, fetch } = recordingFetch()
    const exp = otlpExporter({ url: "http://c", fetch })
    exp.onEnd(span())
    await exp.flush()
    const attrs = (
      (
        calls[0]?.body as {
          resourceSpans: [{ scopeSpans: [{ spans: [Record<string, unknown>] }] }]
        }
      ).resourceSpans[0].scopeSpans[0].spans[0].attributes as Array<{
        key: string
        value: Record<string, unknown>
      }>
    ).reduce<Record<string, unknown>>((acc, kv) => {
      acc[kv.key] = kv.value
      return acc
    }, {})
    expect(attrs["http.response.status_code"]).toEqual({ intValue: "200" })
    expect(attrs["http.request.method"]).toEqual({ stringValue: "GET" })
    expect(attrs.cached).toEqual({ boolValue: true })
  })

  test("error status maps to code 2", async () => {
    const { calls, fetch } = recordingFetch()
    const exp = otlpExporter({ url: "http://c", fetch })
    exp.onEnd(span({ status: "error" }))
    await exp.flush()
    const otlp = (
      calls[0]?.body as { resourceSpans: [{ scopeSpans: [{ spans: [{ status: unknown }] }] }] }
    ).resourceSpans[0].scopeSpans[0].spans[0]
    expect(otlp.status).toEqual({ code: 2 })
  })

  test("serializes causal span links and their typed attributes", async () => {
    const { calls, fetch } = recordingFetch()
    const exp = otlpExporter({ url: "http://c", fetch })
    exp.onEnd(
      span({
        links: [
          {
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
            spanId: "00f067aa0ba902b7",
            attributes: { relationship: "follows_from", attempt: 2, sampled: true },
          },
          { traceId: "11111111111111111111111111111111", spanId: "2222222222222222" },
        ],
      }),
    )
    await exp.flush()

    const links = (
      calls[0]?.body as {
        resourceSpans: [{ scopeSpans: [{ spans: [{ links: Array<Record<string, unknown>> }] }] }]
      }
    ).resourceSpans[0].scopeSpans[0].spans[0].links
    expect(links).toEqual([
      {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        attributes: [
          { key: "relationship", value: { stringValue: "follows_from" } },
          { key: "attempt", value: { intValue: "2" } },
          { key: "sampled", value: { boolValue: true } },
        ],
      },
      { traceId: "11111111111111111111111111111111", spanId: "2222222222222222" },
    ])
  })

  test("flushes automatically once maxBatch spans queue", async () => {
    const { calls, fetch } = recordingFetch()
    const exp = otlpExporter({ url: "http://c", batch: { maxBatch: 3 }, fetch })
    exp.onEnd(span())
    exp.onEnd(span())
    expect(calls).toHaveLength(0)
    exp.onEnd(span())
    // maxBatch reached → auto flush (fire and forget); let the microtask settle
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toHaveLength(1)
    expect(
      (calls[0]?.body as { resourceSpans: [{ scopeSpans: [{ spans: unknown[] }] }] })
        .resourceSpans[0].scopeSpans[0].spans,
    ).toHaveLength(3)
  })

  test("a non-2xx response reaches onError but never throws", async () => {
    const errors: unknown[] = []
    const exp = otlpExporter({
      url: "http://c",
      onError: (e) => errors.push(e),
      fetch: async () => ({ ok: false, status: 503 }),
    })
    exp.onEnd(span())
    await exp.flush()
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain("503")
  })

  test("a thrown fetch (collector down) is caught and reported", async () => {
    const errors: unknown[] = []
    const exp = otlpExporter({
      url: "http://c",
      onError: (e) => errors.push(e),
      fetch: async () => {
        throw new Error("ECONNREFUSED")
      },
    })
    exp.onEnd(span())
    await exp.flush()
    expect(String(errors[0])).toContain("ECONNREFUSED")
  })

  test("queue overflow drops the oldest span and reports it", async () => {
    const errors: unknown[] = []
    const exp = otlpExporter({
      url: "http://c",
      batch: { maxQueue: 2, maxBatch: 100 },
      onError: (e) => errors.push(e),
      fetch: async () => ({ ok: true, status: 200 }),
    })
    exp.onEnd(span())
    exp.onEnd(span())
    exp.onEnd(span()) // overflow
    expect(errors.map(String).some((e) => e.includes("overflow"))).toBe(true)
  })

  test("shutdown flushes the tail", async () => {
    const { calls, fetch } = recordingFetch()
    const exp = otlpExporter({ url: "http://c", fetch })
    exp.onEnd(span())
    await exp.shutdown()
    expect(calls).toHaveLength(1)
  })
})
