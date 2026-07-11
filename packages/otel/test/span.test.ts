import { describe, expect, test } from "bun:test"
import { combineObservationAdapters, consoleSpanExporter, type NifraSpan } from "../src/index.ts"

const sampleSpan = (): NifraSpan => ({
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  parentSpanId: "0123456789abcdef",
  sampled: true,
  name: "GET /ping",
  startTime: 1_000,
  endTime: 1_012,
  durationMs: 12,
  status: "ok",
  attributes: { "http.request.method": "GET", "http.response.status_code": 200 },
})

describe("consoleSpanExporter", () => {
  test("serializes the ended span as one structured JSON line through a custom sink", () => {
    const lines: string[] = []
    const exporter = consoleSpanExporter((l) => lines.push(l))
    exporter.onEnd(sampleSpan())
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]!)
    expect(parsed).toMatchObject({
      name: "GET /ping",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      parentSpanId: "0123456789abcdef",
      durationMs: 12,
      status: "ok",
      "http.request.method": "GET",
      "http.response.status_code": 200, // attributes flattened onto the line
    })
    expect(exporter.onStart).toBeUndefined() // console exporter only needs completed spans
  })

  test("defaults to console.log when no sink is given", () => {
    const original = console.log
    const captured: unknown[] = []
    console.log = (...args: unknown[]) => captured.push(args[0])
    try {
      consoleSpanExporter().onEnd(sampleSpan())
    } finally {
      console.log = original
    }
    expect(captured).toHaveLength(1)
    expect(JSON.parse(String(captured[0])).name).toBe("GET /ping")
  })
})

describe("combineObservationAdapters", () => {
  test("fans out start and end while isolating broken adapters", () => {
    const events: string[] = []
    const combined = combineObservationAdapters([
      {
        onStart() {
          events.push("first:start")
          throw new Error("broken start")
        },
        onEnd() {
          events.push("first:end")
          throw new Error("broken end")
        },
      },
      {
        onStart: () => events.push("second:start"),
        onEnd: () => events.push("second:end"),
      },
      {
        // An end-only adapter is a supported lifecycle sink.
        onEnd: () => events.push("third:end"),
      },
    ])

    const span = sampleSpan()
    combined.onStart?.(span)
    combined.onEnd(span)

    expect(events).toEqual(["first:start", "second:start", "first:end", "second:end", "third:end"])
  })
})
