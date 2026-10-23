import { describe, expect, test } from "bun:test"
import {
  createSagaEngine,
  defineSaga,
  MemorySagaStore,
  reconcileSagas,
  reconcileSagasPage,
  SagaAmbiguousStepError,
  type SagaDefinition,
  type SagaReconciliationFinding,
  type SagaRecord,
  SagaResolutionError,
  SagaStepNotCommittedError,
  type SagaStepRecord,
  type SagaStore,
} from "../src/durable-execution.ts"

type Compensators = { reserve: { id: string }; ship: { id: string } }

const step = (
  name: string,
  state: SagaStepRecord["state"],
  extra: Partial<SagaStepRecord> = {},
): SagaStepRecord => ({
  name,
  effectId: `${name}-effect`,
  compensationEffectId: `${name}-undo`,
  state,
  compensationArgs: { id: name },
  attempts: 0,
  ...extra,
})

const record = (sagaId: string, extra: Partial<SagaRecord> = {}): SagaRecord => ({
  sagaId,
  definition: "orders",
  state: "running",
  input: {},
  steps: [],
  createdAt: 1,
  updatedAt: 1,
  version: 1,
  ...extra,
})

type OrderCompensators = SagaDefinition<Record<string, never>, Compensators>["compensators"]

const orders = (compensators: Partial<OrderCompensators> = {}) =>
  defineSaga<Record<string, never>, Compensators>({
    name: "orders",
    async run() {},
    compensators: { reserve: async () => {}, ship: async () => {}, ...compensators },
  })

function seeded(...records: SagaRecord[]) {
  const store = new MemorySagaStore()
  for (const value of records) store.create(value)
  return { store, engine: createSagaEngine({ store, allowMemoryStore: true, now: () => 10 }) }
}

describe("saga definition refusals", () => {
  const valid = { name: "orders", run: async () => {}, compensators: {} }
  const cases: readonly [string, unknown, string][] = [
    ["definition", null, "saga definition must be an object"],
    ["capability", { ...valid, capability: "not a token" }, "saga capability is invalid"],
    ["compensators", { ...valid, compensators: [] }, "saga compensators must be an object"],
    [
      "compensator",
      { ...valid, compensators: { reserve: "undo" } },
      "saga compensator reserve must be a function",
    ],
    ["retry", { ...valid, retry: null }, "saga retry must be an object"],
    ["backoff", { ...valid, retry: { backoffMs: 5 } }, "saga backoffMs must be a function"],
  ]
  for (const [label, definition, message] of cases) {
    test(`refuses an invalid ${label}`, () => {
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: deliberately malformed definition, to prove the runtime refuses what the type already would.
      expect(() => defineSaga(definition as Parameters<typeof defineSaga>[0])).toThrow(message)
    })
  }

  test("a not-committed error refuses a malformed code", () => {
    expect(new SagaStepNotCommittedError().code).toBe("not_committed")
    expect(() => new SagaStepNotCommittedError("Declined!")).toThrow(
      "saga step error code is invalid",
    )
  })

  test("an engine refuses a memory store unless allowed", () => {
    expect(() => createSagaEngine({ store: new MemorySagaStore() })).toThrow(
      'saga engine requires store.durability === "durable"',
    )
  })
})

describe("saga engine refuses a malformed stored record", () => {
  const cases: readonly [string, Partial<SagaRecord>, string][] = [
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a deliberately unknown stored state, which the engine must refuse.
    ["an unknown state", { state: "paused" as SagaRecord["state"] }, "invalid record"],
    ["an owner without a lease", { owner: "owner-1" }, "an owner without a lease"],
    ["an update before creation", { createdAt: 5, updatedAt: 4 }, "updatedAt precedes createdAt"],
    [
      "a step in an unknown state",
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a deliberately unknown stored step state, which the engine must refuse.
      { steps: [step("reserve", "paused" as SagaStepRecord["state"])] },
      "invalid step record",
    ],
    [
      "a step with a malformed error code",
      { steps: [step("reserve", "failed", { errorCode: "Bad Code" })] },
      "invalid error code",
    ],
  ]
  for (const [label, extra, message] of cases) {
    test(label, async () => {
      const store: SagaStore = {
        durability: "durable",
        create: () => true,
        get: () => record("stored", extra),
        compareAndSet: () => true,
      }
      await expect(createSagaEngine({ store }).resume(orders(), "stored")).rejects.toThrow(message)
    })
  }
})

describe("saga run refusals", () => {
  test("a step without an executor or a compensator fails the run", async () => {
    const { engine } = seeded()
    const noExecute = defineSaga<Record<string, never>, Compensators>({
      name: "orders",
      async run(saga) {
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: deliberately malformed executor, to prove the runtime refuses what the type already would.
        await saga.step("reserve", { id: "r" }, "run" as unknown as () => Promise<string>)
      },
      compensators: { reserve: async () => {}, ship: async () => {} },
    })
    await expect(engine.execute(noExecute, "no-execute", {})).rejects.toThrow(
      "saga step execute must be a function",
    )
    const noCompensator = defineSaga<Record<string, never>, { reserve: { id: string } }>({
      name: "orders",
      async run(saga) {
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a step name with no compensator, which the type already refuses and the runtime must too.
        await (saga.step as (name: string, args: unknown, run: () => unknown) => unknown)(
          "ship",
          { id: "s" },
          async () => "shipped",
        )
      },
      compensators: { reserve: async () => {} },
    })
    await expect(engine.execute(noCompensator, "no-compensator", {})).rejects.toThrow(
      "saga step ship has no compensator",
    )
  })

  test("a step stored as failed cannot resume", async () => {
    const { engine } = seeded(record("failed-step", { steps: [step("reserve", "failed")] }))
    const definition = defineSaga<Record<string, never>, Compensators>({
      name: "orders",
      async run(saga) {
        await saga.step("reserve", { id: "r" }, async () => "again")
      },
      compensators: { reserve: async () => {}, ship: async () => {} },
    })
    await expect(engine.resume(definition, "failed-step")).rejects.toThrow(
      "saga failed-step: step reserve cannot resume from failed",
    )
  })

  test("a provider-proven non-commit records its code and compensates the rest", async () => {
    const undone: string[] = []
    const definition = defineSaga<Record<string, never>, Compensators>({
      name: "orders",
      async run(saga) {
        await saga.step("reserve", { id: "r" }, async () => "reserved")
        await saga.step("ship", { id: "s" }, async () => {
          throw new SagaStepNotCommittedError("carrier_refused")
        })
      },
      compensators: {
        reserve: async () => {
          undone.push("reserve")
        },
        ship: async () => {
          undone.push("ship")
        },
      },
    })
    const { store, engine } = seeded()
    await expect(engine.execute(definition, "refused", {})).rejects.toBeInstanceOf(
      SagaStepNotCommittedError,
    )
    const stored = await store.get("refused")
    expect(stored?.state).toBe("compensated")
    expect(stored?.steps.map((item) => [item.name, item.state, item.errorCode])).toEqual([
      ["reserve", "compensated", undefined],
      ["ship", "failed", "carrier_refused"],
    ])
    expect(undone).toEqual(["reserve"])
  })

  test("a release whose reload fails leaves the lease to lapse", async () => {
    const inner = new MemorySagaStore()
    let gets = 0
    const store: SagaStore = {
      durability: "durable",
      create: (value) => inner.create(value),
      get: (sagaId) => {
        if (++gets > 1) throw new Error("store offline")
        return inner.get(sagaId)
      },
      compareAndSet: (input) => inner.compareAndSet(input),
    }
    inner.create(record("offline", { state: "completed" }))
    expect((await createSagaEngine({ store }).resume(orders(), "offline")).state).toBe("completed")
    expect(gets).toBe(2)
  })
})

describe("saga compensation refusals", () => {
  test("an ambiguous step moves a compensating saga to manual review", async () => {
    const { store, engine } = seeded(
      record("ambiguous", { state: "compensating", steps: [step("reserve", "executing")] }),
    )
    await expect(engine.compensate(orders(), "ambiguous")).rejects.toBeInstanceOf(
      SagaAmbiguousStepError,
    )
    expect((await store.get("ambiguous"))?.state).toBe("manual-review")
  })

  test("a step whose compensator is gone goes to manual review", async () => {
    const { engine } = seeded(
      record("no-undo", { state: "compensating", steps: [step("pack", "committed")] }),
    )
    expect((await engine.compensate(orders(), "no-undo")).state).toBe("manual-review")
  })

  test("a step out of attempts goes to manual review", async () => {
    const { engine } = seeded(
      record("spent", {
        state: "compensating",
        steps: [step("reserve", "compensation-failed", { attempts: 3 })],
      }),
    )
    expect((await engine.compensate(orders(), "spent")).state).toBe("manual-review")
  })

  test("a failed compensation retries on the default backoff", async () => {
    const { store, engine } = seeded(
      record("retry", { state: "compensating", steps: [step("reserve", "committed")] }),
    )
    const definition = orders({
      reserve: async () => {
        throw new Error("provider down")
      },
    })
    expect((await engine.compensate(definition, "retry")).state).toBe("compensating")
    expect((await store.get("retry"))?.steps[0]).toMatchObject({
      state: "compensation-failed",
      errorCode: "compensation_failed",
      attempts: 1,
      nextAttemptAt: 110,
    })
  })

  test("a backoff that returns a negative delay stops in manual review", async () => {
    const { store, engine } = seeded(
      record("bad-backoff", { state: "compensating", steps: [step("reserve", "committed")] }),
    )
    const definition = defineSaga<Record<string, never>, Compensators>({
      name: "orders",
      async run() {},
      compensators: {
        reserve: async () => {
          throw new Error("provider down")
        },
        ship: async () => {},
      },
      retry: { backoffMs: () => -1 },
    })
    await expect(engine.compensate(definition, "bad-backoff")).rejects.toThrow(
      "saga backoff must return a non-negative safe integer",
    )
    const stored = await store.get("bad-backoff")
    expect(stored?.state).toBe("manual-review")
    expect(stored?.steps[0]?.errorCode).toBe("invalid_retry_policy")
  })
})

describe("saga ambiguity resolution refusals", () => {
  const ambiguous = () =>
    seeded(
      record("review", {
        state: "manual-review",
        steps: [
          step("reserve", "committed"),
          step("ship", "ambiguous", { attempts: 3 }),
          step("pack", "compensating", { attempts: 3 }),
        ],
      }),
    )

  test("refuses a malformed resolution", async () => {
    const { engine } = ambiguous()
    await expect(
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: deliberately malformed resolution, to prove the runtime refuses what the type already would.
      engine.resolveAmbiguity(orders(), "review", null as unknown as never),
    ).rejects.toThrow("saga resolution must be an object")
    await expect(
      engine.resolveAmbiguity(orders(), "review", {
        kind: "compensation",
        step: "pack",
        effectId: "pack-undo",
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: deliberately malformed outcome, to prove the runtime refuses what the type already would.
        outcome: "committed" as "compensated",
      }),
    ).rejects.toThrow("saga resolution kind or outcome is invalid")
  })

  test("refuses an execution resolution for a step that is not ambiguous", async () => {
    const { engine } = ambiguous()
    await expect(
      engine.resolveAmbiguity(orders(), "review", {
        kind: "execution",
        step: "reserve",
        effectId: "reserve-effect",
        outcome: "committed",
        result: "reserved",
      }),
    ).rejects.toThrow("is not awaiting an execution resolution (committed)")
  })

  test("a not-committed resolution fails the step, and refuses a malformed code", async () => {
    const { store, engine } = ambiguous()
    await expect(
      engine.resolveAmbiguity(orders(), "review", {
        kind: "execution",
        step: "ship",
        effectId: "ship-effect",
        outcome: "not-committed",
        errorCode: "Bad Code",
      }),
    ).rejects.toThrow("saga resolution errorCode is invalid")
    const resolved = await engine.resolveAmbiguity(orders(), "review", {
      kind: "execution",
      step: "ship",
      effectId: "ship-effect",
      outcome: "not-committed",
    })
    expect(resolved.state).toBe("compensating")
    expect((await store.get("review"))?.steps[1]).toMatchObject({
      state: "failed",
      errorCode: "not_committed",
    })
  })

  test("refuses a compensation resolution with the wrong id or state", async () => {
    const { engine } = ambiguous()
    for (const [stepName, effectId, message] of [
      ["pack", "pack-effect", "compensation effect id does not match"],
      ["ship", "ship-undo", "is not awaiting a compensation resolution (ambiguous)"],
    ] as const)
      await expect(
        engine.resolveAmbiguity(orders(), "review", {
          kind: "compensation",
          step: stepName,
          effectId,
          outcome: "compensated",
        }),
      ).rejects.toThrow(new SagaResolutionError("review", stepName, message))
  })

  test("a not-compensated step out of attempts stays in manual review", async () => {
    const { engine } = ambiguous()
    const resolved = await engine.resolveAmbiguity(orders(), "review", {
      kind: "compensation",
      step: "pack",
      effectId: "pack-undo",
      outcome: "not-compensated",
    })
    expect(resolved.state).toBe("manual-review")
    expect(resolved.steps[2]?.state).toBe("compensation-failed")
  })
})

describe("saga reconciliation", () => {
  test("reports an ambiguous compensation and a stale run, through list() or scan()", async () => {
    const records = [
      record("undoing", { state: "compensating", steps: [step("pack", "compensating")] }),
      record("stale", { updatedAt: 2 }),
      record("fresh", { updatedAt: 50 }),
      record("done", { state: "completed" }),
    ]
    const { store } = seeded(...records)
    expect(store.list().map((value) => value.sagaId)).toEqual(["undoing", "stale", "fresh", "done"])
    const listOnly: SagaStore = {
      create: () => true,
      get: () => undefined,
      compareAndSet: () => false,
      list: () => store.list(),
    }
    const expected: SagaReconciliationFinding[] = [
      {
        sagaId: "undoing",
        state: "compensating",
        step: "pack",
        effectId: "pack-undo",
        reason: "ambiguous-compensation",
      },
      { sagaId: "stale", state: "running", reason: "stale-running" },
    ]
    for (const source of [store, listOnly]) {
      const findings = await reconcileSagas(source, { staleBefore: 10 })
      expect([...findings].sort((a, b) => (a.sagaId < b.sagaId ? 1 : -1))).toEqual(expected)
    }
  })

  test("refuses a store with no scan or list, and a sweep past one page", async () => {
    await expect(
      reconcileSagasPage(
        { create: () => true, get: () => undefined, compareAndSet: () => false },
        { staleBefore: 0 },
      ),
    ).rejects.toThrow("saga store does not support reconciliation")
    const { store } = seeded(
      ...Array.from({ length: 1_001 }, (_, index) => record(`saga-${index}`)),
    )
    await expect(reconcileSagas(store, { staleBefore: 0 })).rejects.toThrow(
      "saga reconciliation exceeds 1000 records; use reconcileSagasPage()",
    )
  })
})
