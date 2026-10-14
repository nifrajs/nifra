import { describe, expect, test } from "bun:test"
import {
  createObservationLifecycle,
  type NifraSpan,
  type ObservationAdapter,
  type ObservationLifecycle,
} from "../src/index.ts"

describe("observation lifecycle", () => {
  test("custom start-only lifecycles remain compatible with the public interface", () => {
    const factory = createObservationLifecycle()
    const custom: ObservationLifecycle = { start: factory.start }
    expect(custom.start({ name: "custom" }).end().name).toBe("custom")
    expect(factory.record({ name: "completed" }, { durationMs: 1 }).name).toBe("completed")
  })

  test("record observes later configured adapters without duplicating a sink", () => {
    const seen: string[] = []
    const first: ObservationAdapter = {
      onEnd() {
        seen.push("first")
      },
    }
    const second: ObservationAdapter = {
      onEnd() {
        seen.push("second")
      },
    }
    const adapters = [first]
    const lifecycle = createObservationLifecycle({ adapters })
    lifecycle.record({ name: "first" }, { durationMs: 1 })
    adapters.push(first, second)
    lifecycle.record({ name: "second" }, { durationMs: 1 })
    expect(seen).toEqual(["first", "first", "second"])
  })

  test("record keeps start/end ordering, parentage, timing, deduplication and immutable exports", () => {
    const events: string[] = []
    const adapter: ObservationAdapter = {
      onStart(span) {
        events.push(span.status)
        span.attributes.started = true
      },
      onEnd(span) {
        events.push(span.status)
      },
    }
    const lifecycle = createObservationLifecycle({
      adapters: [
        adapter,
        adapter,
        {
          onStart() {
            throw new Error("isolated")
          },
          onEnd() {
            throw new Error("isolated")
          },
        },
      ],
      generateSpanId: () => "b".repeat(16),
      clock: { wallTime: () => 1000, monotonicTime: () => 10 },
    })
    const span = lifecycle.record(
      {
        name: "cache wrap",
        parent: { traceId: "a".repeat(32), spanId: "c".repeat(16), sampled: false },
        startTime: 900,
      },
      { durationMs: 5, status: "error" },
    )
    expect(events).toEqual(["unset", "error"])
    expect(span).toMatchObject({
      traceId: "a".repeat(32),
      parentSpanId: "c".repeat(16),
      sampled: false,
      startTime: 900,
      endTime: 905,
      durationMs: 5,
      attributes: { started: true },
    })
    expect(Object.isFrozen(span)).toBe(true)
    expect(Object.isFrozen(span.attributes)).toBe(true)
  })

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
