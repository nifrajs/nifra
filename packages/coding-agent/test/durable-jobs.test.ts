import { describe, expect, test } from "bun:test"
import {
  createMemoryRunDispatchStore,
  createRunDispatch,
  deriveRunIdempotencyKey,
  parseRunDispatch,
  TestClock,
} from "../src/orchestration/index.ts"

const PLAN_DIGEST = "a".repeat(64)

function dispatch(maxAttempts = 3) {
  return createRunDispatch({
    dispatchId: "dispatch-1",
    runId: "run-1",
    planDigest: PLAN_DIGEST,
    nodeId: "node-1",
    maxAttempts,
    notBefore: 0,
  })
}

describe("durable jobs dispatch adapter", () => {
  test("leases and completes a run node through the real JobStore shape", async () => {
    const clock = new TestClock(100)
    const store = createMemoryRunDispatchStore({ now: clock.now })
    await store.enqueue(dispatch())

    const [lease] = await store.lease(clock.now(), 1, 50)
    expect(lease).toBeDefined()
    expect(lease?.attempt).toBe(1)
    expect(lease?.idempotencyKey).toBe(
      await deriveRunIdempotencyKey(PLAN_DIGEST, "run-1", "node-1", 1),
    )
    expect(
      (
        await store.checkpoint(lease!, {
          version: 1,
          dispatchId: "dispatch-1",
          runId: "run-1",
          nodeId: "node-1",
          attempt: lease!.attempt,
          generation: lease!.generation,
          boundary: "before-effect",
          idempotencyKey: lease!.idempotencyKey,
          at: clock.now(),
          scheduleToken: lease!.scheduleToken,
        })
      ).ok,
    ).toBe(true)
    expect((await store.complete(lease!)).ok).toBe(true)
    expect((await store.inspect("dispatch-1"))?.state).toBe("succeeded")
  })

  test("duplicate delivery keeps the logical key and rejects the older lease", async () => {
    const clock = new TestClock(0)
    const store = createMemoryRunDispatchStore({ now: clock.now })
    await store.enqueue(dispatch())
    const [first] = await store.lease(0, 1, 10)
    clock.advance(11)
    const [second] = await store.lease(clock.now(), 1, 10)

    expect(second?.attempt).toBe(first?.attempt)
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey)
    expect(second?.generation).not.toBe(first?.generation)
    expect((await store.complete(first!)).code).toBe("stale_lease")
    expect((await store.complete(second!)).ok).toBe(true)
  })

  test("retry advances the logical attempt and key", async () => {
    const clock = new TestClock(0)
    const store = createMemoryRunDispatchStore({ now: clock.now })
    await store.enqueue(dispatch(2))
    const [first] = await store.lease(0, 1, 10)
    expect((await store.retry(first!, 20, "effect_rejected")).ok).toBe(true)
    clock.advance(20)
    const [second] = await store.lease(clock.now(), 1, 10)
    expect(second?.attempt).toBe(2)
    expect(second?.idempotencyKey).not.toBe(first?.idempotencyKey)
    expect((await store.complete(second!)).ok).toBe(true)
  })

  test("dispatch parser rejects unknown and content-bearing fields", () => {
    expect(() =>
      parseRunDispatch({
        version: 1,
        dispatchId: "d",
        runId: "r",
        planDigest: PLAN_DIGEST,
        nodeId: "n",
        maxAttempts: 1,
        notBefore: 0,
        output: "never",
      }),
    ).toThrow()
    expect(() =>
      parseRunDispatch({
        version: 1,
        dispatchId: "d",
        runId: "r",
        planDigest: PLAN_DIGEST,
        nodeId: "n",
        maxAttempts: 1,
        notBefore: 0,
        extra: true,
      }),
    ).toThrow()
  })
})
