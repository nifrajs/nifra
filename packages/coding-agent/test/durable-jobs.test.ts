import { describe, expect, test } from "bun:test"
import { MemoryJobStore } from "@nifrajs/jobs"
import {
  createDurableJobsStore,
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

  test("a cancel accepted while a transition awaits the job store is not overwritten", async () => {
    for (const transition of ["complete", "retry", "deadLetter"] as const) {
      const held = Promise.withResolvers<void>()
      let reached!: () => void
      const waiting = new Promise<void>((resolve) => {
        reached = resolve
      })
      // A job store whose terminal writes are held until the cancel has gone through.
      class HeldJobStore extends MemoryJobStore {
        override async complete(id: string): Promise<void> {
          reached()
          await held.promise
          return super.complete(id)
        }
        override async retry(id: string, runAt: number): Promise<void> {
          reached()
          await held.promise
          return super.retry(id, runAt)
        }
        override async deadLetter(id: string, reason: string): Promise<void> {
          if (reason !== "effect_rejected") return super.deadLetter(id, reason)
          reached()
          await held.promise
          return super.deadLetter(id, reason)
        }
      }
      const clock = new TestClock(0)
      const store = createDurableJobsStore({ store: new HeldJobStore(), now: clock.now })
      await store.enqueue(dispatch())
      const [lease] = await store.lease(0, 1, 10)
      const written =
        transition === "complete"
          ? store.complete(lease!)
          : transition === "retry"
            ? store.retry(lease!, 5, "effect_rejected")
            : store.deadLetter(lease!, "effect_rejected")
      await waiting
      expect(await store.cancel("run-1")).toBe(1)
      held.resolve()
      expect((await written).code).toBe("cancelled")
      expect((await store.inspect("dispatch-1"))?.state).toBe("cancelled")
    }
  })

  test("a dispatch cancelled while its lease is being issued is not handed out", async () => {
    const store = createMemoryRunDispatchStore({ now: () => 0 })
    await store.enqueue(dispatch())
    const leasing = store.lease(0, 1, 10)
    // The lease marks the entry before it derives the idempotency key; cancel lands in that gap.
    while ((await store.inspect("dispatch-1"))?.state !== "leased") await Promise.resolve()
    expect(await store.cancel("run-1")).toBe(1)
    expect(await leasing).toEqual([])
    expect((await store.inspect("dispatch-1"))?.state).toBe("cancelled")
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
