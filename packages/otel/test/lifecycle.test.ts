import { describe, expect, test } from "bun:test"
import {
  createObservationLifecycle,
  type NifraSpan,
  type ObservationAdapter,
} from "../src/index.ts"

describe("observation lifecycle", () => {
  test("owns parentage, monotonic timing, errors, and final classification", () => {
    const ended: NifraSpan[] = []
    const times = { wall: 1_000, monotonic: 10 }
    const lifecycle = createObservationLifecycle({
      adapters: [{ onEnd: (span) => ended.push(span) }],
      clock: {
        wallTime: () => times.wall,
        monotonicTime: () => times.monotonic,
      },
      generateTraceId: () => "a".repeat(32),
      generateSpanId: (() => {
        let id = 0
        return () => (++id).toString(16).padStart(16, "0")
      })(),
    })

    const request = lifecycle.start({ name: "GET /x" })
    const child = request.startChild({ name: "tool:x" })
    expect(child.span.traceId).toBe(request.span.traceId)
    expect(child.span.parentSpanId).toBe(request.span.spanId)

    child.recordError(new Error("handled"))
    times.wall = 900 // wall clocks can move backwards
    times.monotonic = 22.5
    child.end({ statusCode: 404 })
    child.end({ statusCode: 500 })

    expect(child.span.durationMs).toBe(12.5)
    expect(child.span.status).toBe("ok")
    expect(child.span.attributes["error.recorded"]).toBe(true)
    expect(child.span.attributes["error.message"]).toBeUndefined()
    expect(ended).toEqual([child.span]) // completion is exactly once
  })

  test("records error evidence without copying sensitive error text into exported attributes", () => {
    const ended: NifraSpan[] = []
    const observation = createObservationLifecycle({
      adapters: [{ onEnd: (span) => ended.push(span) }],
    }).start({ name: "GET /private" })

    observation.recordError(new Error("postgres://user:secret@db.internal/private"))
    observation.end({ statusCode: 500 })

    expect(ended[0]?.attributes["error.recorded"]).toBe(true)
    expect(JSON.stringify(ended[0]?.attributes)).not.toContain("secret")
    expect(ended[0]?.attributes["error.message"]).toBeUndefined()
  })

  test("isolates every adapter failure", () => {
    const seen: string[] = []
    const broken: ObservationAdapter = {
      onStart() {
        throw new Error("start")
      },
      onEnd() {
        throw new Error("end")
      },
    }
    const lifecycle = createObservationLifecycle({
      adapters: [broken, { onStart: () => seen.push("start"), onEnd: () => seen.push("end") }],
    })
    lifecycle.start({ name: "safe" }).end()
    expect(seen).toEqual(["start", "end"])
  })

  test("attaches an adapter to an in-flight observation once", () => {
    const seen: string[] = []
    const adapter: ObservationAdapter = {
      onStart: () => seen.push("start"),
      onEnd: () => seen.push("end"),
    }
    const observation = createObservationLifecycle().start({ name: "GET /dynamic" })
    observation.addAdapter(adapter)
    observation.addAdapter(adapter)
    observation.end()
    expect(seen).toEqual(["start", "end"])
  })

  test("records work after it settled from an explicit start time and duration", () => {
    const clock = { wallTime: () => 5_000, monotonicTime: () => 77 }
    const lifecycle = createObservationLifecycle({ clock })
    const recorded = lifecycle
      .start({ name: "cache get", startTime: 1_000 })
      .end({ durationMs: 2.5 })
    expect(recorded).toMatchObject({ startTime: 1_000, endTime: 1_002.5, durationMs: 2.5 })

    const negative = lifecycle.start({ name: "skewed", startTime: 1_000 }).end({ durationMs: -3 })
    expect(negative).toMatchObject({ startTime: 1_000, endTime: 1_000, durationMs: 0 })

    const invalid = lifecycle
      .start({ name: "bad", startTime: Number.NaN })
      .end({ durationMs: Number.POSITIVE_INFINITY })
    expect(invalid).toMatchObject({ startTime: 5_000, endTime: 5_000, durationMs: 0 })
  })
})
