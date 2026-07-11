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
    expect(child.span.attributes["error.message"]).toBe("handled")
    expect(ended).toEqual([child.span]) // completion is exactly once
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
})
