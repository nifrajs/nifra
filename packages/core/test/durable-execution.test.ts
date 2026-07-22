import { describe, expect, test } from "bun:test"
import { executeCapability } from "../src/capabilities.ts"
import {
  ApprovalBindingError,
  ApprovalDeniedError,
  ApprovalPendingError,
  ApprovalRequiredError,
  ApprovalTokenExpiredError,
  ApprovalTokenInvalidError,
  ApprovalTokenReplayError,
  createApprovalCoordinator,
  createDurableEffectJournal,
  createSagaEngine,
  defineSaga,
  MemoryApprovalStore,
  MemoryDurableEffectStore,
  MemorySagaStore,
  reconcileEffects,
  reconcileEffectsPage,
  reconcileSagas,
  reconcileSagasPage,
  SagaAmbiguousStepError,
} from "../src/durable-execution.ts"
import { server } from "../src/server.ts"

const secret = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32))
const approvalInput = (resumeToken?: string) => ({
  effectId: crypto.randomUUID(),
  capability: "payments.charge",
  target: "provider:stripe",
  digest: "a".repeat(64),
  identity: { tenantId: "tenant_1", principalId: "user_1" },
  ...(resumeToken === undefined ? {} : { resumeToken }),
  signal: new AbortController().signal,
})

describe("durable approvals", () => {
  test("signed resume tokens are tenant-bound, operation-bound, and single-use", async () => {
    const store = new MemoryApprovalStore()
    const approval = createApprovalCoordinator({ store, secret: secret(), allowMemoryStore: true })
    let required: ApprovalRequiredError | undefined
    try {
      await approval.authorize(approvalInput())
    } catch (error) {
      expect(error).toBeInstanceOf(ApprovalRequiredError)
      required = error as ApprovalRequiredError
    }
    expect(required).toBeDefined()
    expect(Object.keys(required as ApprovalRequiredError)).not.toContain("resumeToken")
    expect(JSON.stringify(required)).not.toContain(required?.resumeToken as string)
    await expect(approval.authorize(approvalInput(required?.resumeToken))).rejects.toBeInstanceOf(
      ApprovalPendingError,
    )
    expect((await approval.get(required?.approvalId as string))?.state).toBe("pending")
    await approval.decide({
      approvalId: required?.approvalId as string,
      tenantId: "tenant_1",
      decision: "approved",
      decidedBy: "reviewer_1",
    })

    await expect(
      approval.authorize({
        ...approvalInput(required?.resumeToken),
        identity: { tenantId: "tenant_2", principalId: "user_1" },
      }),
    ).rejects.toBeInstanceOf(ApprovalBindingError)
    await expect(
      approval.authorize({ ...approvalInput(required?.resumeToken), target: "provider:other" }),
    ).rejects.toBeInstanceOf(ApprovalBindingError)
    const concurrent = await Promise.allSettled([
      approval.authorize(approvalInput(required?.resumeToken)),
      approval.authorize(approvalInput(required?.resumeToken)),
    ])
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(
      concurrent.some(
        (result) =>
          result.status === "rejected" && result.reason instanceof ApprovalTokenReplayError,
      ),
    ).toBe(true)
    await expect(approval.authorize(approvalInput(required?.resumeToken))).rejects.toBeInstanceOf(
      ApprovalTokenReplayError,
    )

    let denied: ApprovalRequiredError | undefined
    try {
      await approval.authorize(approvalInput())
    } catch (error) {
      denied = error as ApprovalRequiredError
    }
    await approval.decide({
      approvalId: denied?.approvalId as string,
      tenantId: "tenant_1",
      decision: "denied",
      decidedBy: "reviewer_1",
    })
    await expect(approval.authorize(approvalInput(denied?.resumeToken))).rejects.toBeInstanceOf(
      ApprovalDeniedError,
    )
  })

  test("forged and expired tokens fail closed", async () => {
    let now = 1_000
    const approval = createApprovalCoordinator({
      store: new MemoryApprovalStore(),
      secret: secret(),
      ttlMs: 10,
      now: () => now,
      allowMemoryStore: true,
    })
    let required: ApprovalRequiredError | undefined
    try {
      await approval.authorize(approvalInput())
    } catch (error) {
      required = error as ApprovalRequiredError
    }
    const token = required?.resumeToken as string
    const forged = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`
    await expect(approval.authorize(approvalInput(forged))).rejects.toBeInstanceOf(
      ApprovalTokenInvalidError,
    )
    now = 1_011
    await expect(approval.authorize(approvalInput(token))).rejects.toBeInstanceOf(
      ApprovalTokenExpiredError,
    )
  })

  test("executeCapability suspends before the effect and resumes only after approval", async () => {
    const approval = createApprovalCoordinator({
      store: new MemoryApprovalStore(),
      secret: secret(),
      allowMemoryStore: true,
    })
    const journalStore = new MemoryDurableEffectStore()
    const journal = createDurableEffectJournal({ store: journalStore, allowMemoryStore: true })
    let resumeToken: string | undefined
    let approvalId: string | undefined
    let executions = 0
    const app = server({ logger: { debug() {}, info() {}, warn() {}, error() {} } })
      .onError((error) => {
        if (error instanceof ApprovalRequiredError) {
          resumeToken = error.resumeToken
          approvalId = error.approvalId
          return new Response(null, { status: 202 })
        }
        return undefined
      })
      .post("/charge", { capabilities: ["payments.charge"] }, async (c) => {
        await executeCapability(
          c,
          "payments.charge",
          {
            target: "provider:stripe",
            approval: {
              gate: approval,
              tenantId: "tenant_1",
              principalId: "user_1",
              ...(resumeToken === undefined ? {} : { resumeToken }),
            },
            journal,
          },
          async () => {
            executions++
          },
        )
        return { ok: true }
      })

    expect(
      (await app.fetch(new Request("http://nifra.test/charge", { method: "POST" }))).status,
    ).toBe(202)
    expect(executions).toBe(0)
    await approval.decide({
      approvalId: approvalId as string,
      tenantId: "tenant_1",
      decision: "approved",
      decidedBy: "reviewer_1",
    })
    expect(
      (await app.fetch(new Request("http://nifra.test/charge", { method: "POST" }))).status,
    ).toBe(200)
    expect(executions).toBe(1)
    expect((await journalStore.list()).map((record) => record.state)).toEqual([
      "failed",
      "committed",
    ])
  })
})

describe("durable journal and saga reconciliation", () => {
  test("stale pre-effect records are incomplete and executing records are ambiguous", async () => {
    const store = new MemoryDurableEffectStore()
    const journal = createDurableEffectJournal({ store, now: () => 10, allowMemoryStore: true })
    await journal.intent({ effectId: "effect_incomplete", capability: "db.write" })
    await journal.intent({ effectId: "effect_ambiguous", capability: "payments.charge" })
    await journal.executing("effect_ambiguous")
    expect(await reconcileEffects(store, { staleBefore: 10 })).toEqual([
      { effectId: "effect_incomplete", capability: "db.write", state: "incomplete", updatedAt: 10 },
      {
        effectId: "effect_ambiguous",
        capability: "payments.charge",
        state: "ambiguous",
        updatedAt: 10,
      },
    ])
  })

  test("effect reconciliation is cursor-paginated and bounded", async () => {
    const store = new MemoryDurableEffectStore()
    const journal = createDurableEffectJournal({ store, now: () => 10, allowMemoryStore: true })
    await journal.intent({ effectId: "effect_1", capability: "db.write" })
    await journal.intent({ effectId: "effect_2", capability: "db.write" })

    const first = await reconcileEffectsPage(store, { staleBefore: 10, limit: 1 })
    expect(first.findings.map((finding) => finding.effectId)).toEqual(["effect_1"])
    expect(first.cursor).toBeDefined()
    const second = await reconcileEffectsPage(store, {
      staleBefore: 10,
      limit: 1,
      ...(first.cursor === undefined ? {} : { cursor: first.cursor }),
    })
    expect(second.findings.map((finding) => finding.effectId)).toEqual(["effect_2"])
    expect(second.cursor).toBeUndefined()
  })

  test("compatibility reconciliation fails loudly instead of silently truncating", async () => {
    class OverflowStore extends MemoryDurableEffectStore {
      override scan(
        input: Parameters<MemoryDurableEffectStore["scan"]>[0],
      ): ReturnType<MemoryDurableEffectStore["scan"]> {
        const page = super.scan(input)
        return { ...page, cursor: "more" }
      }
    }
    const store = new OverflowStore()
    const journal = createDurableEffectJournal({ store, now: () => 10, allowMemoryStore: true })
    await journal.intent({ effectId: "effect_1", capability: "db.write" })

    await expect(reconcileEffects(store, { staleBefore: 10 })).rejects.toThrow(
      "use reconcileEffectsPage()",
    )
  })

  test("a lost post-commit journal transition becomes unknown instead of retryable", async () => {
    class LostCommitStore extends MemoryDurableEffectStore {
      override transition(input: Parameters<MemoryDurableEffectStore["transition"]>[0]): boolean {
        if (input.to === "committed") return false
        return super.transition(input)
      }
    }
    const store = new LostCommitStore()
    const journal = createDurableEffectJournal({ store, allowMemoryStore: true })
    let executions = 0
    const app = server({ logger: { debug() {}, info() {}, warn() {}, error() {} } }).post(
      "/charge",
      { capabilities: ["payments.charge"] },
      async (c) =>
        executeCapability(c, "payments.charge", { journal }, async () => {
          executions++
        }),
    )
    expect(
      (await app.fetch(new Request("http://nifra.test/charge", { method: "POST" }))).status,
    ).toBe(500)
    expect(executions).toBe(1)
    expect((await store.list())[0]?.state).toBe("unknown")
    expect(await reconcileEffects(store, { staleBefore: Date.now() })).toEqual([
      expect.objectContaining({ state: "ambiguous" }),
    ])
  })

  test("compensates committed steps in reverse order and retries with a stable effect id", async () => {
    let now = 100
    const order: string[] = []
    const compensationIds: string[] = []
    let secondAttempts = 0
    const definition = defineSaga<
      { fail: boolean },
      { reserve: { reservationId: string }; charge: { paymentId: string } }
    >({
      name: "checkout",
      capability: "orders.checkout",
      async run(saga, input) {
        await saga.step("reserve", { reservationId: "r_1" }, async () => {
          order.push("execute:reserve")
          return "reserved"
        })
        await saga.step("charge", { paymentId: "p_1" }, async () => {
          order.push("execute:charge")
          return "charged"
        })
        if (input.fail) throw new Error("business failure")
      },
      compensators: {
        reserve: async (_args, context) => {
          compensationIds.push(context.effectId)
          order.push("compensate:reserve")
        },
        charge: async (_args, context) => {
          compensationIds.push(context.effectId)
          secondAttempts++
          order.push("compensate:charge")
          if (secondAttempts === 1) throw new Error("temporary")
        },
      },
      retry: { maxAttempts: 2, backoffMs: () => 5 },
    })
    const store = new MemorySagaStore()
    const engine = createSagaEngine({ store, now: () => now, allowMemoryStore: true })
    await expect(engine.execute(definition, "saga_1", { fail: true })).rejects.toThrow(
      "business failure",
    )
    expect((await store.get("saga_1"))?.state).toBe("compensating")
    now = 105
    const settled = await engine.compensate(definition, "saga_1")
    expect(settled.state).toBe("compensated")
    expect(order).toEqual([
      "execute:reserve",
      "execute:charge",
      "compensate:charge",
      "compensate:charge",
      "compensate:reserve",
    ])
    expect(compensationIds[0]).toBe(compensationIds[1])
  })

  test("an unknown step outcome is never repeated automatically and is reconciled", async () => {
    const definition = defineSaga<Record<never, never>, { charge: { paymentId: string } }>({
      name: "ambiguous-charge",
      async run(saga) {
        await saga.step("charge", { paymentId: "p_1" }, async () => {
          throw new Error("connection dropped")
        })
      },
      compensators: { charge: async () => {} },
    })
    const store = new MemorySagaStore()
    const engine = createSagaEngine({ store, allowMemoryStore: true })
    await expect(engine.execute(definition, "saga_ambiguous", {})).rejects.toThrow(
      "connection dropped",
    )
    await expect(engine.resume(definition, "saga_ambiguous")).resolves.toMatchObject({
      state: "manual-review",
    })
    expect(await reconcileSagas(store, { staleBefore: Date.now() })).toEqual([
      expect.objectContaining({
        sagaId: "saga_ambiguous",
        reason: "ambiguous-execution",
        step: "charge",
      }),
    ])
    await expect(engine.compensate(definition, "saga_ambiguous")).rejects.toBeInstanceOf(
      SagaAmbiguousStepError,
    )

    const page = await reconcileSagasPage(store, { staleBefore: Date.now(), limit: 1 })
    expect(page.findings).toHaveLength(1)
    expect(page.cursor).toBeUndefined()
  })

  test("compensation retry exhaustion stops in manual review", async () => {
    const definition = defineSaga<{ fail: boolean }, { reserve: { id: string } }>({
      name: "exhausted-compensation",
      async run(saga, input) {
        await saga.step("reserve", { id: "r_1" }, async () => undefined)
        if (input.fail) throw new Error("abort")
      },
      compensators: {
        reserve: async () => {
          throw new Error("provider down")
        },
      },
      retry: { maxAttempts: 1 },
    })
    const store = new MemorySagaStore()
    const engine = createSagaEngine({ store, allowMemoryStore: true })
    await expect(engine.execute(definition, "saga_exhausted", { fail: true })).rejects.toThrow(
      "abort",
    )
    expect((await store.get("saga_exhausted"))?.state).toBe("manual-review")
  })
})
