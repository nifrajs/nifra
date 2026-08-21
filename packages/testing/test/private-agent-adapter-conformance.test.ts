import { expect, test } from "bun:test"
import {
  createMemoryRunDispatchStore,
  createRunDispatch,
  type DurableDispatchAdapter,
  parseRunDispatchEvidence,
  type RunDispatchEvidence,
} from "../../coding-agent/src/orchestration/index.ts"

type PrivateContext = Readonly<{
  authorized: boolean
  dataLayerAuthorized: boolean
  secretAvailable: boolean
}>

type PrivateFixture = DurableDispatchAdapter<PrivateContext> & {
  readonly evidence: RunDispatchEvidence[]
  readonly retentionChecks: number[]
  readonly reconciliation: string[]
  readonly logs: string[]
  readonly secretUses: number
  useTransientSecret(context: PrivateContext): string | undefined
}

function fakePrivateAdapter(now: () => number): PrivateFixture {
  const base = createMemoryRunDispatchStore({ now })
  const evidence: RunDispatchEvidence[] = []
  const retentionChecks: number[] = []
  const reconciliation: string[] = []
  const logs: string[] = []
  let secretUses = 0

  const authorize = (context: PrivateContext): boolean => context.authorized === true
  const enforceDataLayerPolicy = (context: PrivateContext): boolean =>
    context.dataLayerAuthorized === true

  return {
    ...base,
    evidence,
    retentionChecks,
    reconciliation,
    logs,
    get secretUses() {
      return secretUses
    },
    authorize: (context) => authorize(context),
    enforceDataLayerPolicy: (context) => enforceDataLayerPolicy(context),
    retainEvidence: (context, value) => {
      if (!authorize(context) || !enforceDataLayerPolicy(context))
        throw new Error("private policy denied evidence retention")
      const parsed = parseRunDispatchEvidence(value)
      evidence.push(parsed)
      retentionChecks.push(parsed.at)
      logs.push(JSON.stringify({ code: "evidence.retained", dispatchId: parsed.dispatchId }))
    },
    reconcile: (context, dispatchId) => {
      if (!authorize(context) || !enforceDataLayerPolicy(context))
        throw new Error("private policy denied reconciliation")
      reconciliation.push(dispatchId)
      logs.push(JSON.stringify({ code: "dispatch.reconciled", dispatchId }))
    },
    workerHealth: (context) => (authorize(context) ? "ready" : "unavailable"),
    useTransientSecret: (context) => {
      if (!authorize(context) || context.secretAvailable !== true) return undefined
      secretUses += 1
      return "transient-secret"
    },
  }
}

test("a private adapter satisfies the handoff without leaking operated data", async () => {
  let now = 0
  const adapter = fakePrivateAdapter(() => now)
  const allowed = Object.freeze({
    authorized: true,
    dataLayerAuthorized: true,
    secretAvailable: true,
  })
  const denied = Object.freeze({
    authorized: false,
    dataLayerAuthorized: false,
    secretAvailable: false,
  })
  const dispatch = createRunDispatch({
    dispatchId: "private-dispatch",
    runId: "private-run",
    planDigest: "d".repeat(64),
    nodeId: "private-node",
    maxAttempts: 1,
    notBefore: 0,
  })

  expect(await adapter.authorize(denied, "enqueue")).toBe(false)
  expect(await adapter.enforceDataLayerPolicy(denied, "write")).toBe(false)
  expect(await adapter.workerHealth(denied)).toBe("unavailable")
  expect(adapter.useTransientSecret(allowed)).toBe("transient-secret")
  expect(adapter.secretUses).toBe(1)

  await adapter.enqueue(dispatch)
  const [first] = await adapter.lease(now, 1, 10)
  expect(first).toBeDefined()
  now = 11
  const [duplicate] = await adapter.lease(now, 1, 10)
  expect(duplicate).toBeDefined()
  expect(duplicate!.idempotencyKey).toBe(first!.idempotencyKey)
  expect((await adapter.complete(first!)).code).toBe("stale_lease")
  expect((await adapter.complete(duplicate!)).ok).toBe(true)

  await adapter.retainEvidence(allowed, {
    version: 1,
    dispatchId: dispatch.dispatchId,
    runId: dispatch.runId,
    nodeId: dispatch.nodeId,
    state: "succeeded",
    attempt: duplicate!.attempt,
    generation: duplicate!.generation,
    at: now,
    scheduleToken: duplicate!.scheduleToken,
    idempotencyKey: duplicate!.idempotencyKey,
  })
  await adapter.reconcile(allowed, dispatch.dispatchId)

  expect(await adapter.workerHealth(allowed)).toBe("ready")
  expect(adapter.retentionChecks).toEqual([now])
  expect(adapter.reconciliation).toEqual([dispatch.dispatchId])
  expect(adapter.evidence).toHaveLength(1)
  expect(adapter.logs.every((entry) => !entry.includes("transient-secret"))).toBe(true)
  expect(JSON.stringify(adapter.evidence)).not.toMatch(/tenant|row|credential|payload|transcript/i)
  expect(() =>
    parseRunDispatchEvidence({ ...adapter.evidence[0], artifact: "caller-owned" }),
  ).toThrow()
})
