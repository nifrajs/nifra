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
