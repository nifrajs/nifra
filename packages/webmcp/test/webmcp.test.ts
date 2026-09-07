import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import {
  type AgentCapability,
  createPredictionStore,
  defineAgentCapability,
  executePredicted,
  registerWebMcpTools,
  runAgentSurfaceConformance,
  toWebMcpTool,
  type WebMcpTarget,
  type WebMcpToolDefinition,
} from "../src/index.ts"

interface CartState {
  readonly items: readonly { readonly sku: string; readonly quantity: number }[]
}

function capability(
  execute: (input: { sku: string; quantity: number }) => Promise<{ version: string }>,
): AgentCapability<{ sku: string; quantity: number }, { version: string }, CartState> {
  return defineAgentCapability({
    name: "cart.add",
    description: "Add an item to the cart.",
    input: t.object({ sku: t.string(), quantity: t.number() }),
    output: t.object({ version: t.string() }),
    annotations: { readOnlyHint: false, idempotentHint: true },
    writes: ["cart"],
    execute,
    predict: ({ input, version }) => ({
      baseVersion: version,
      patch: [{ op: "add", path: "/items/-", value: input }],
    }),
    reconcile: ({ previous, output }) => ({
      state: {
        items: [...previous.state.items, { sku: "server", quantity: 1 }],
      },
      version: output.version,
    }),
  })
}

function host(options: { failName?: string; unregister?: boolean } = {}): {
  target: WebMcpTarget
  registered: Map<string, WebMcpToolDefinition>
  removed: string[]
} {
  const registered = new Map<string, WebMcpToolDefinition>()
  const removed: string[] = []
  const modelContext = {
    registerTool(tool: WebMcpToolDefinition) {
      if (options.failName === tool.name) throw new Error("host refused tool")
      registered.set(tool.name, tool)
    },
    ...(options.unregister === false
      ? {}
      : {
          unregisterTool(name: string) {
            registered.delete(name)
            removed.push(name)
          },
        }),
  }
  return { target: { modelContext }, registered, removed }
}

describe("WebMCP projection", () => {
  test("projects the typed core contract and returns a verifiable receipt", async () => {
    const tool = toWebMcpTool(
      defineAgentCapability({
        name: "cart.read",
        description: "Read the cart.",
        input: t.object({}),
        output: t.object({ count: t.number() }),
        annotations: { readOnlyHint: true },
        sensitivity: "public",
        execute: () => ({ count: 2 }),
      }),
    )
    expect(tool.name).toBe("cart.read")
    expect(tool.inputSchema).toMatchObject({ type: "object" })
    expect(tool.annotations.readOnlyHint).toBe(true)
    await expect(tool.execute({ extra: true })).resolves.toMatchObject({
      ok: false,
      outcome: "failed",
      error: { code: "input_invalid" },
    })
    await expect(tool.execute({})).resolves.toMatchObject({
      ok: true,
      outcome: "committed",
      output: { count: 2 },
    })
  })

  test("registration is explicit, isolates failures, and cleans up idempotently", async () => {
    const good = defineAgentCapability({
      name: "cart.read",
      description: "Read the cart.",
      input: t.object({}),
      output: t.object({ ok: t.boolean() }),
      execute: () => ({ ok: true }),
    })
    const failing = defineAgentCapability({
      name: "cart.write",
      description: "Write the cart.",
      input: t.object({}),
      output: t.object({ ok: t.boolean() }),
      execute: () => ({ ok: true }),
    })
    const first = host({ failName: "cart.write" })
    const report = await registerWebMcpTools([good, failing, good], first.target)
    expect(report.supported).toBe(true)
    expect(report.registered).toEqual(["cart.read"])
    expect(report.failed).toEqual([
      { name: "cart.write", error: "host refused tool" },
      { name: "cart.read", error: "duplicate tool name is already registered" },
    ])
    await report.cleanup()
    await report.cleanup()
    expect(first.removed).toEqual(["cart.read"])
    expect(first.registered.size).toBe(0)
  })

  test("reserves names across concurrent registrations and releases failed reservations", async () => {
    const item = defineAgentCapability({
      name: "cart.concurrent",
      description: "A concurrently registered tool.",
      input: t.object({}),
      output: t.object({ ok: t.boolean() }),
      execute: () => ({ ok: true }),
    })
    const registered = new Map<string, WebMcpToolDefinition>()
    let started!: () => void
    const registrationStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let release!: () => void
    const registrationReleased = new Promise<void>((resolve) => {
      release = resolve
    })
    let shouldFail = false
    const target: WebMcpTarget = {
      modelContext: {
        async registerTool(tool) {
          started()
          await registrationReleased
          if (shouldFail) throw new Error("host refused concurrent tool")
          registered.set(tool.name, tool)
        },
        unregisterTool(name) {
          registered.delete(name)
        },
      },
    }

    const firstPromise = registerWebMcpTools([item], target)
    await registrationStarted
    const duplicate = await registerWebMcpTools([item], target)
    expect(duplicate.registered).toEqual([])
    expect(duplicate.failed).toEqual([
      { name: "cart.concurrent", error: "duplicate tool name is already registered" },
    ])

    release()
    const first = await firstPromise
    expect(first.registered).toEqual(["cart.concurrent"])
    await first.cleanup()
    expect(registered.size).toBe(0)

    // A rejected host call must not leave a phantom reservation that blocks a later retry.
    shouldFail = true
    let failedStarted!: () => void
    const failedRegistrationStarted = new Promise<void>((resolve) => {
      failedStarted = resolve
    })
    // The host has already been released for the first call; use a new target for the failure/retry
    // half so this test does not depend on resetting a one-shot gate.
    let rejectRelease!: () => void
    const rejectGate = new Promise<void>((resolve) => {
      rejectRelease = resolve
    })
    let failNext = true
    const retryTarget: WebMcpTarget = {
      modelContext: {
        async registerTool(tool) {
          failedStarted()
          await rejectGate
          if (failNext) {
            failNext = false
            throw new Error("host refused once")
          }
          registered.set(tool.name, tool)
        },
        unregisterTool(name) {
          registered.delete(name)
        },
      },
    }
    const failedPromise = registerWebMcpTools([item], retryTarget)
    await failedRegistrationStarted
    rejectRelease()
    const failed = await failedPromise
    expect(failed.registered).toEqual([])
    const retry = await registerWebMcpTools([item], retryTarget)
    expect(retry.registered).toEqual(["cart.concurrent"])
    await retry.cleanup()
  })

  test("unsupported hosts are a safe no-op", async () => {
    const report = await registerWebMcpTools([], {})
    expect(report).toMatchObject({ supported: false, registered: [], failed: [] })
    await report.cleanup()
  })

  test("accepts heterogeneous capability registries", async () => {
    const read = defineAgentCapability({
      name: "cart.read",
      description: "Read the cart.",
      input: t.object({}),
      output: t.object({ count: t.number() }),
      execute: () => ({ count: 0 }),
    })
    const search = defineAgentCapability({
      name: "catalog.search",
      description: "Search the catalog.",
      input: t.object({ query: t.string() }),
      output: t.object({ ids: t.array(t.string()) }),
      execute: ({ query }) => ({ ids: query.length === 0 ? [] : ["sku-1"] }),
    })
    const fake = host()
    const report = await registerWebMcpTools([read, search], fake.target)
    expect(report.registered).toEqual(["cart.read", "catalog.search"])
    await report.cleanup()
  })

  test("bounds receipt output while preserving explicit raw-output mode", async () => {
    const value = "x".repeat(2_000)
    const capability = defineAgentCapability({
      name: "cart.large",
      description: "Return a large response.",
      input: t.object({}),
      output: t.object({ value: t.string() }),
      execute: () => ({ value }),
    })
    const receipt = await toWebMcpTool(capability, { maxReceiptBytes: 256 }).execute({})
    expect(receipt).toMatchObject({ ok: true, outputTruncated: true })
    expect(receipt).not.toHaveProperty("output")
    await expect(
      toWebMcpTool(capability, { maxReceiptBytes: 256, resultMode: "output" }).execute({}),
    ).resolves.toEqual({ value })
  })

  test("contains page-local authorization failures", async () => {
    const capability = defineAgentCapability({
      name: "cart.guard",
      description: "Guarded cart operation.",
      input: t.object({}),
      output: t.object({ ok: t.boolean() }),
      execute: () => ({ ok: true }),
    })
    await expect(
      toWebMcpTool(capability, {
        authorize: () => {
          throw new Error("private guard detail")
        },
      }).execute({}),
    ).resolves.toMatchObject({
      ok: false,
      outcome: "denied",
      error: { code: "capability_denied" },
    })
  })
})

describe("prediction store", () => {
  test("applies predictions atomically and commits authoritative state", () => {
    const store = createPredictionStore({ state: { items: [] as string[] }, version: "v1" })
    const events: string[] = []
    store.subscribe((event) => events.push(event.type))
    expect(
      store.predict("p1", {
        baseVersion: "v1",
        patch: [{ op: "add", path: "/items/-", value: "optimistic" }],
      }),
    ).toMatchObject({ outcome: "predicted", snapshot: { state: { items: ["optimistic"] } } })
    expect(store.commit("p1", { state: { items: ["server"] }, version: "v2" })).toMatchObject({
      outcome: "committed",
      snapshot: { state: { items: ["server"] }, version: "v2" },
    })
    expect(events).toEqual(["predicted", "committed"])
  })

  test("rejects stale, expired, and prototype-grafting predictions without mutation", () => {
    const store = createPredictionStore({ state: { ok: true }, version: "v1" })
    expect(
      store.predict("stale", {
        baseVersion: "v0",
        patch: [{ op: "replace", path: "/ok", value: false }],
      }),
    ).toMatchObject({ outcome: "stale" })
    expect(
      store.predict("expired", {
        baseVersion: "v1",
        expiresAt: 0,
        patch: [{ op: "replace", path: "/ok", value: false }],
      }),
    ).toMatchObject({ outcome: "expired" })
    expect(() =>
      store.predict("pollute", {
        baseVersion: "v1",
        patch: [{ op: "add", path: "/__proto__/polluted", value: true }],
      }),
    ).toThrow(TypeError)
    expect(store.snapshot()).toMatchObject({ state: { ok: true }, activePredictionIds: [] })
  })

  test("rolls back failed execution and reconciles successful execution", async () => {
    const success = capability(async () => ({ version: "v2" }))
    const store = createPredictionStore<CartState>({ state: { items: [] }, version: "v1" })
    const committed = await executePredicted(success, { sku: "a", quantity: 1 }, store, {
      predictionId: "p-success",
    })
    expect(committed.outcome).toBe("committed")
    expect(committed.snapshot.version).toBe("v2")

    const failure = capability(async () => {
      throw new Error("down")
    })
    const failed = await executePredicted(failure, { sku: "b", quantity: 1 }, store, {
      predictionId: "p-failure",
    })
    expect(failed.outcome).toBe("rolled-back")
    expect(failed.snapshot.activePredictionIds).toEqual([])
  })

  test("rolls back a prediction when execution is cancelled after it becomes visible", async () => {
    let release!: (value: { version: string }) => void
    let started = false
    const pending = new Promise<{ version: string }>((resolve) => {
      release = resolve
    })
    const cancellable: AgentCapability<
      { sku: string; quantity: number },
      { version: string },
      CartState
    > = defineAgentCapability({
      name: "cart.cancel",
      description: "A cancellable cart operation.",
      input: t.object({ sku: t.string(), quantity: t.number() }),
      output: t.object({ version: t.string() }),
      execute: (_input, context) => {
        started = true
        expect(context.signal).toBeInstanceOf(AbortSignal)
        return pending
      },
      predict: ({ input, version }) => ({
        baseVersion: version,
        patch: [{ op: "add", path: "/items/-", value: input }],
      }),
      reconcile: ({ previous, output }) => ({
        state: previous.state,
        version: output.version,
      }),
    })
    const store = createPredictionStore<CartState>({ state: { items: [] }, version: "v1" })
    const controller = new AbortController()
    const execution = executePredicted(cancellable, { sku: "a", quantity: 1 }, store, {
      signal: controller.signal,
      predictionId: "p-cancel",
    })
    for (
      let attempt = 0;
      attempt < 100 && (!started || store.snapshot().activePredictionIds.length === 0);
      attempt += 1
    )
      await new Promise((resolve) => setTimeout(resolve, 1))
    expect(started).toBe(true)
    expect(store.snapshot().activePredictionIds).toEqual(["p-cancel"])
    controller.abort("user left")
    release({ version: "v2" })
    const result = await execution
    expect(result.outcome).toBe("rolled-back")
    expect(result.snapshot.activePredictionIds).toEqual([])
  })

  test("conflicts when the authoritative version changes before commit", () => {
    const store = createPredictionStore({ state: { count: 0 }, version: "v1" })
    const events: string[] = []
    store.subscribe((event) => events.push(event.type))
    store.predict("p1", { baseVersion: "v1", patch: [{ op: "replace", path: "/count", value: 1 }] })
    store.predict("p2", { baseVersion: "v1", patch: [{ op: "replace", path: "/count", value: 2 }] })
    expect(store.commit("p1", { state: { count: 1 }, version: "v2" })).toMatchObject({
      outcome: "committed",
      snapshot: { activePredictionIds: [] },
    })
    expect(store.commit("p2", { state: { count: 2 }, version: "v3" })).toMatchObject({
      outcome: "conflicted",
    })
    expect(store.snapshot().version).toBe("v2")
    expect(events).toEqual(["predicted", "predicted", "committed", "conflicted"])
  })

  test("bounds active predictions", () => {
    const store = createPredictionStore({ state: { ok: true }, version: "v1" })
    for (let index = 0; index < 256; index += 1) {
      expect(
        store.predict(`p-${index}`, {
          baseVersion: "v1",
          patch: [{ op: "replace", path: "/ok", value: index % 2 === 0 }],
        }),
      ).toMatchObject({ outcome: "predicted" })
    }
    expect(
      store.predict("overflow", {
        baseVersion: "v1",
        patch: [{ op: "replace", path: "/ok", value: false }],
      }),
    ).toMatchObject({ outcome: "invalid" })
  })
})

describe("agent surface conformance", () => {
  test("runs host registration and calls without ChatGPT", async () => {
    const item = defineAgentCapability({
      name: "cart.read",
      description: "Read the cart.",
      input: t.object({}),
      output: t.object({ ok: t.boolean() }),
      execute: () => ({ ok: true }),
    })
    const fake = host()
    const result = await runAgentSurfaceConformance([item], {
      target: fake.target,
      cases: [
        {
          capability: item,
          input: {},
          assert(value) {
            expect(value).toMatchObject({ ok: true, outcome: "committed" })
          },
        },
      ],
    })
    expect(result.supported).toBe(true)
    expect(result.checks).toEqual([
      "unique standard descriptors",
      "host registration",
      "call cart.read",
    ])
    expect(fake.registered.size).toBe(0)
  })
})
