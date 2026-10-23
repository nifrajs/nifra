import { expect, test } from "bun:test"
import {
  createMemoryRunDispatchStore,
  createRunDispatch,
  EffectRejectedError,
  MemoryIdempotencyProofStore,
  RecoveryCrashError,
  RunRecoveryMachine,
  TestClock,
} from "../src/orchestration/index.ts"

const PLAN_DIGEST = "b".repeat(64)

function makeDispatch(maxAttempts = 3) {
  return createRunDispatch({
    dispatchId: `dispatch-${maxAttempts}`,
    runId: "run-recovery",
    planDigest: PLAN_DIGEST,
    nodeId: "node-recovery",
    maxAttempts,
    notBefore: 0,
  })
}

test("recovery completes an effect and leaves evidence-only state", async () => {
  const clock = new TestClock(0)
  const store = createMemoryRunDispatchStore({ now: clock.now })
  await store.enqueue(makeDispatch())
  let effects = 0
  const machine = new RunRecoveryMachine({ store, clock: { now: clock.now }, leaseMs: 10 })
  const result = await machine.process(async () => {
    effects++
    return { committed: true }
  })

  expect(result.completed).toBe(1)
  expect(effects).toBe(1)
  expect((await store.inspect("dispatch-3"))?.state).toBe("succeeded")
  expect(JSON.stringify(await store.inspect("dispatch-3"))).not.toMatch(
    /prompt|output|input|secret/i,
  )
})
test("crash after effect converges by proof without running the effect twice", async () => {
  const clock = new TestClock(0)
  const store = createMemoryRunDispatchStore({ now: clock.now })
  const proofs = new MemoryIdempotencyProofStore()
  await store.enqueue(makeDispatch())
  let effects = 0
  const machine = new RunRecoveryMachine({
    store,
    clock: { now: clock.now },
    proofStore: proofs,
    leaseMs: 10,
  })
  const first = await machine.process(async ({ lease }) => {
    effects++
    proofs.record(lease.idempotencyKey)
    throw new RecoveryCrashError("after-effect")
  })
  expect(first.completed).toBe(0)
  clock.advance(11)
  const second = await machine.process(async () => {
    effects++
    return { committed: true }
  })
  expect(second.completed).toBe(1)
  expect(effects).toBe(1)
})

test("a worker lost after the effect ran, before its proof, is dead-lettered on redelivery", async () => {
  const clock = new TestClock(0)
  const store = createMemoryRunDispatchStore({ now: clock.now })
  await store.enqueue(makeDispatch())
  let effects = 0
  const machine = new RunRecoveryMachine({ store, clock: { now: clock.now }, leaseMs: 10 })
  await machine.process(async () => {
    effects++
    throw new RecoveryCrashError("after-effect")
  })
  clock.advance(11)
  const second = await machine.process(async () => {
    effects++
    return { committed: true }
  })
  expect(second.deadLettered).toBe(1)
  expect(effects).toBe(1)
  expect(store.deadLetters()[0]?.code).toBe("idempotency_required")
})

test("crash after a safe checkpoint reruns only the uncommitted effect", async () => {
  const clock = new TestClock(0)
  const store = createMemoryRunDispatchStore({ now: clock.now })
  await store.enqueue(makeDispatch())
  let effects = 0
  const machine = new RunRecoveryMachine({ store, clock: { now: clock.now }, leaseMs: 10 })
  const first = await machine.process(async ({ checkpoint }) => {
    expect(await checkpoint("before-effect")).toBe(true)
    throw new RecoveryCrashError("after-checkpoint")
  })
  expect(first.completed).toBe(0)
  clock.advance(11)
  const second = await machine.process(async () => {
    effects++
    return { committed: true }
  })
  expect(second.completed).toBe(1)
  expect(effects).toBe(1)
})

test("an unproven post-effect failure is dead-lettered instead of retried", async () => {
  const clock = new TestClock(0)
  const store = createMemoryRunDispatchStore({ now: clock.now })
  await store.enqueue(makeDispatch())
  const machine = new RunRecoveryMachine({ store, clock: { now: clock.now }, leaseMs: 10 })
  const result = await machine.process(async () => {
    throw new Error("opaque failure")
  })
  expect(result.deadLettered).toBe(1)
  expect(store.deadLetters()[0]?.code).toBe("idempotency_required")
})

test("explicit pre-effect rejection retries with a new key and converges", async () => {
  const clock = new TestClock(0)
  const store = createMemoryRunDispatchStore({ now: clock.now })
  await store.enqueue(makeDispatch(2))
  let calls = 0
  const machine = new RunRecoveryMachine({
    store,
    clock: { now: clock.now },
    leaseMs: 10,
    retryBackoff: () => 5,
  })
  const first = await machine.process(async () => {
    calls++
    throw new EffectRejectedError("not_ready")
  })
  expect(first.retried).toBe(1)
  clock.advance(5)
  const second = await machine.process(async () => {
    calls++
    return { committed: true }
  })
  expect(second.completed).toBe(1)
  expect(calls).toBe(2)
})

test("cancellation wins races against late completion", async () => {
  const clock = new TestClock(0)
  const store = createMemoryRunDispatchStore({ now: clock.now })
  await store.enqueue(makeDispatch())
  const [lease] = await store.lease(0, 1, 100)
  expect(await store.cancel("run-recovery")).toBe(1)
  expect((await store.complete(lease!)).ok).toBe(false)
  expect((await store.inspect("dispatch-3"))?.state).toBe("cancelled")
})

test("options and the test clock are range-checked", () => {
  const store = createMemoryRunDispatchStore({ now: () => 0 })
  expect(() => new RunRecoveryMachine({ store, leaseMs: 0 })).toThrow(
    "recovery leaseMs must be positive",
  )
  expect(() => new TestClock(-1)).toThrow("test clock start is invalid")
  expect(() => new TestClock(0).advance(-1)).toThrow("test clock advance is invalid")
})

test("an aborted machine cancels the run before any effect runs", async () => {
  const clock = new TestClock(0)
  const store = createMemoryRunDispatchStore({ now: clock.now })
  await store.enqueue(makeDispatch())
  const controller = new AbortController()
  controller.abort()
  const machine = new RunRecoveryMachine({ store, clock, leaseMs: 10, signal: controller.signal })
  let effects = 0
  const result = await machine.process(async () => {
    effects++
    return { committed: true }
  })
  expect(result.cancelled).toBe(1)
  expect(effects).toBe(0)
  expect((await store.inspect("dispatch-3"))?.state).toBe("cancelled")
})

test("an abort that lands at the effect-started checkpoint cancels before the effect", async () => {
  const clock = new TestClock(0)
  const store = createMemoryRunDispatchStore({ now: clock.now })
  await store.enqueue(makeDispatch())
  const controller = new AbortController()
  const checkpoint = store.checkpoint.bind(store)
  store.checkpoint = async (lease, record) => {
    const outcome = await checkpoint(lease, record)
    if (record.boundary === "effect-started") controller.abort()
    return outcome
  }
  const machine = new RunRecoveryMachine({ store, clock, leaseMs: 10, signal: controller.signal })
  let effects = 0
  const result = await machine.process(async () => {
    effects++
    return { committed: true }
  })
  expect(result.cancelled).toBe(1)
  expect(effects).toBe(0)
})

test("an effect that aborts its own signal cancels the run", async () => {
  const clock = new TestClock(0)
  const store = createMemoryRunDispatchStore({ now: clock.now })
  await store.enqueue(makeDispatch())
  const controller = new AbortController()
  const machine = new RunRecoveryMachine({ store, clock, leaseMs: 10, signal: controller.signal })
  const result = await machine.process(async ({ signal }) => {
    controller.abort()
    throw signal.reason
  })
  expect(result.cancelled).toBe(1)
})

test("an effect that reports no commit is dead-lettered", async () => {
  const clock = new TestClock(0)
  const store = createMemoryRunDispatchStore({ now: clock.now })
  const proofs = new MemoryIdempotencyProofStore()
  await store.enqueue(makeDispatch())
  const machine = new RunRecoveryMachine({ store, clock, leaseMs: 10, proofStore: proofs })
  const result = await machine.process(async () => ({ committed: false }) as never)
  expect(result.deadLettered).toBe(1)
  expect(store.deadLetters()[0]?.code).toBe("idempotency_required")
  expect(proofs.keysSnapshot()).toEqual([])
})

test("a rejection on the last attempt dead-letters with the rejection's code", async () => {
  const clock = new TestClock(0)
  const store = createMemoryRunDispatchStore({ now: clock.now })
  const proofs = new MemoryIdempotencyProofStore()
  await store.enqueue(makeDispatch(1))
  const machine = new RunRecoveryMachine({ store, clock, leaseMs: 10, proofStore: proofs })
  const result = await machine.process(async () => {
    throw new EffectRejectedError("not_ready")
  })
  expect(result.deadLettered).toBe(1)
  expect(store.deadLetters()[0]?.code).toBe("not_ready")
})

test("a retry backoff that is not a finite delay is refused", async () => {
  const clock = new TestClock(0)
  const store = createMemoryRunDispatchStore({ now: clock.now })
  await store.enqueue(makeDispatch())
  const machine = new RunRecoveryMachine({ store, clock, leaseMs: 10, retryBackoff: () => -1 })
  await expect(
    machine.process(async () => {
      throw new EffectRejectedError("not_ready")
    }),
  ).rejects.toThrow("recovery retry backoff is invalid")
})

test("cancel stops every dispatch of the run", async () => {
  const clock = new TestClock(0)
  const store = createMemoryRunDispatchStore({ now: clock.now })
  await store.enqueue(makeDispatch())
  const machine = new RunRecoveryMachine({ store, clock, leaseMs: 10 })
  expect(await machine.cancel("run-recovery")).toBe(1)
  expect((await store.inspect("dispatch-3"))?.state).toBe("cancelled")
})
