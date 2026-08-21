import { expect, test } from "bun:test"
import {
  createMemoryRunDispatchStore,
  createRunDispatch,
  type DurableDispatchAdapter,
  type RunDispatchEvidence,
} from "../src/orchestration/index.ts"

/** Conformance-only fake: the context is opaque and no private data model is represented. */
function fakePrivateAdapter(): DurableDispatchAdapter<object> & {
  readonly evidence: RunDispatchEvidence[]
} {
  const base = createMemoryRunDispatchStore({ now: () => 0 })
  const evidence: RunDispatchEvidence[] = []
  return {
    ...base,
    evidence,
    authorize: () => true,
    enforceDataLayerPolicy: () => true,
    retainEvidence: (_context, value) => {
      evidence.push(value)
    },
    reconcile: () => undefined,
    workerHealth: () => "ready",
  }
}

test("private dispatch handoff stays opaque and conforms to public ports", async () => {
  const adapter = fakePrivateAdapter()
  const context = Object.freeze({ scope: "opaque" })
  const dispatch = createRunDispatch({
    dispatchId: "private-dispatch",
    runId: "private-run",
    planDigest: "c".repeat(64),
    nodeId: "private-node",
    maxAttempts: 1,
    notBefore: 0,
  })
  expect(await adapter.authorize(context, "enqueue")).toBe(true)
  expect(await adapter.enforceDataLayerPolicy(context, "write")).toBe(true)
  await adapter.enqueue(dispatch)
  const [lease] = await adapter.lease(0, 1, 10)
  expect(lease).toBeDefined()
  expect((await adapter.complete(lease!)).ok).toBe(true)
  expect(await adapter.workerHealth(context)).toBe("ready")
  await adapter.reconcile(context, dispatch.dispatchId)
  await adapter.retainEvidence(context, {
    version: 1,
    dispatchId: dispatch.dispatchId,
    runId: dispatch.runId,
    nodeId: dispatch.nodeId,
    state: "succeeded",
    attempt: 1,
    generation: lease!.generation,
    at: 0,
    scheduleToken: lease!.scheduleToken,
    idempotencyKey: lease!.idempotencyKey,
  })
  expect(adapter.evidence).toHaveLength(1)
  expect(JSON.stringify(adapter.evidence)).not.toMatch(/tenant|row|rls|credential|payload/i)
})
