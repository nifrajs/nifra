import { describe, expect, test } from "bun:test"
import {
  type EffectLifecycleEvent,
  type EmitEffectLifecycleInput,
  effectTraceParentOf,
  emitEffectLifecycle,
} from "../src/effect-lifecycle.ts"

const traceId = "0123456789abcdef0123456789abcdef"
const spanId = "0123456789abcdef"

describe("effect trace parents", () => {
  test("copies a well-formed trace and refuses a malformed one", () => {
    const trace = effectTraceParentOf({ trace: { traceId, spanId, sampled: true, extra: 1 } })
    expect(trace).toEqual({ traceId, spanId, sampled: true })
    expect(Object.isFrozen(trace)).toBe(true)
    for (const bad of [
      { traceId: 1, spanId, sampled: true },
      { traceId: "ABC", spanId, sampled: true },
      { traceId, spanId: 2, sampled: true },
      { traceId, spanId: "short", sampled: true },
      { traceId, spanId, sampled: "yes" },
    ])
      expect(effectTraceParentOf({ trace: bad })).toBeUndefined()
    expect(effectTraceParentOf({})).toBeUndefined()
  })
})

describe("effect lifecycle emission", () => {
  const base: EmitEffectLifecycleInput = {
    effectId: "effect-1",
    capability: "orders.write",
    stage: "execution",
    phase: "failed",
    at: 5,
  }

  function emitted(input: EmitEffectLifecycleInput): EffectLifecycleEvent[] {
    const events: EffectLifecycleEvent[] = []
    emitEffectLifecycle([(event) => events.push(event)], input)
    return events
  }

  test("drops an event with invalid metadata, timing, attempt or error code", () => {
    for (const input of [
      { ...base, cost: { calls: -1 } },
      { ...base, durationMs: -1 },
      { ...base, durationMs: Number.NaN },
      { ...base, attempt: 0 },
      { ...base, attempt: 1.5 },
      { ...base, errorCode: "Bad Code" },
      { ...base, errorCode: 7 as unknown as string },
    ])
      expect(emitted(input)).toEqual([])
  })

  test("carries the optional fields and survives an observer that throws", () => {
    const events: EffectLifecycleEvent[] = []
    emitEffectLifecycle(
      [
        () => {
          throw new Error("sink down")
        },
        (event) => events.push(event),
      ],
      {
        ...base,
        durationMs: 3,
        attempt: 2,
        errorCode: "provider_down",
        target: "provider:acme",
        cost: { calls: 1 },
        trace: { traceId, spanId, sampled: false },
      },
    )
    expect(events).toEqual([
      {
        ...base,
        durationMs: 3,
        attempt: 2,
        errorCode: "provider_down",
        target: "provider:acme",
        cost: { calls: 1 },
        trace: { traceId, spanId, sampled: false },
      },
    ])
    expect(Object.isFrozen(events[0])).toBe(true)
  })
})
