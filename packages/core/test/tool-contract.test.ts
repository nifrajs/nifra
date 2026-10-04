import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import {
  createToolBudget,
  createToolHttpHandler,
  DEFAULT_TOOL_MAX_BYTES,
  defineTool,
  executeTool,
  MemoryToolIdempotencyStore,
  runToolContractConformance,
  type ToolIdempotencyStore,
} from "../src/tool-contract.ts"

const input = t.object({ name: t.string({ minLength: 1 }) })
const output = t.object({ ok: t.boolean() })

describe("typed tool contracts", () => {
  test("runs the fixed fail-closed pipeline and records token-only evidence", async () => {
    let executions = 0
    const tool = defineTool({
      name: "orders.lookup",
      description: "Look up an order.",
      input,
      output,
      capability: "orders.read",
      cost: { calls: 1 },
      execute: async () => {
        executions += 1
        return { ok: true }
      },
    })
    const result = await executeTool(
      tool,
      { name: "private-value" },
      { capabilities: ["orders.read"] },
    )
    expect(result.ok).toBe(true)
    expect(executions).toBe(1)
    expect(result.ledger.entries.map((entry) => entry.phase)).toEqual(["intent", "committed"])
    expect(result.evidence.map((item) => item.stage)).toEqual([
      "input",
      "capability",
      "approval",
      "idempotency",
      "budget",
      "execution",
      "output",
    ])
    expect(JSON.stringify(result.ledger)).not.toContain("private-value")
  })

  test("denies missing capability and never calls the executor", async () => {
    let executions = 0
    const tool = defineTool({
      name: "orders.write",
      description: "Write an order.",
      input,
      output,
      capability: "orders.write",
      execute: () => {
        executions += 1
        return { ok: true }
      },
    })
    const result = await executeTool(tool, { name: "a" })
    expect(result).toMatchObject({ ok: false, error: { code: "capability_denied" } })
    expect(executions).toBe(0)
    expect(result.ledger.entries.at(-1)?.error).toEqual({ code: "capability_denied" })
  })

  test("requires approval, supports thresholds, and keeps denial in the evidence trail", async () => {
    let executions = 0
    const tool = defineTool({
      name: "orders.refund",
      description: "Refund an order.",
      input,
      output,
      capability: "orders.refund",
      approval: { kind: "threshold", level: 2 },
      execute: () => {
        executions += 1
        return { ok: true }
      },
    })
    const denied = await executeTool(tool, { name: "a" }, { capabilities: ["orders.refund"] })
    expect(denied).toMatchObject({ ok: false, error: { code: "approval_required" } })
    const under = await executeTool(
      tool,
      { name: "a" },
      { capabilities: ["orders.refund"], approval: { granted: true, level: 1 } },
    )
    expect(under).toMatchObject({ ok: false, error: { code: "approval_denied" } })
    const allowed = await executeTool(
      tool,
      { name: "a" },
      { capabilities: ["orders.refund"], approval: { granted: true, level: 2 } },
    )
    expect(allowed.ok).toBe(true)
    expect(executions).toBe(1)
  })

  test("dry-run validates and budgets without executing or reserving an effect", async () => {
    let executions = 0
    const tool = defineTool({
      name: "orders.charge",
      description: "Charge an order.",
      input,
      output,
      capability: "orders.charge",
      idempotency: { scope: "request", key: (value) => value.name },
      cost: { calls: 1 },
      execute: () => {
        executions += 1
        return { ok: true }
      },
    })
    const store = new MemoryToolIdempotencyStore()
    const result = await executeTool(
      tool,
      { name: "a" },
      {
        capabilities: ["orders.charge"],
        idempotency: store,
        dryRun: true,
        budget: createToolBudget({ limits: { calls: 1 } }),
      },
    )
    expect(result).toMatchObject({ ok: true, dryRun: true })
    expect(result.output).toBeUndefined()
    expect(executions).toBe(0)
    expect(result.evidence.some((item) => item.outcome === "dry-run")).toBe(true)
    const actual = await executeTool(
      tool,
      { name: "a" },
      { capabilities: ["orders.charge"], idempotency: store },
    )
    expect(actual.ok).toBe(true)
    expect(executions).toBe(1)
    const duplicate = await executeTool(
      tool,
      { name: "a" },
      { capabilities: ["orders.charge"], idempotency: store },
    )
    expect(duplicate).toMatchObject({ ok: false, error: { code: "idempotency_duplicate" } })
  })

  test("budget exhaustion fails before the executor", async () => {
    let executions = 0
    const tool = defineTool({
      name: "orders.expensive",
      description: "Expensive order operation.",
      input,
      output,
      capability: "orders.expensive",
      cost: { calls: 2 },
      execute: () => {
        executions += 1
        return { ok: true }
      },
    })
    const result = await executeTool(
      tool,
      { name: "a" },
      { capabilities: ["orders.expensive"], budget: createToolBudget({ limits: { calls: 1 } }) },
    )
    expect(result).toMatchObject({ ok: false, error: { code: "budget_exceeded" } })
    expect(executions).toBe(0)
  })

  test("does not release an idempotency reservation after an invalid output", async () => {
    let executions = 0
    const tool = defineTool({
      name: "orders.invalid-output",
      description: "Return an invalid result after an effect.",
      input,
      output,
      capability: "orders.invalid-output",
      idempotency: { scope: "request", key: (value) => value.name },
      execute: () => {
        executions += 1
        return { ok: "not-a-boolean" } as never
      },
    })
    const idempotency = new MemoryToolIdempotencyStore()
    const options = { capabilities: ["orders.invalid-output"], idempotency }
    const first = await executeTool(tool, { name: "a" }, options)
    const retry = await executeTool(tool, { name: "a" }, options)
    expect(first).toMatchObject({ ok: false, error: { code: "output_invalid" } })
    expect(retry).toMatchObject({ ok: false, error: { code: "idempotency_duplicate" } })
    expect(executions).toBe(1)
  })

  test("a pending tool key lapses after its lease unless renewed, and a completed one holds for ttlMs", () => {
    let now = 0
    const store = new MemoryToolIdempotencyStore({ ttlMs: 1000, now: () => now })
    const first = store.begin({ namespace: "ns", key: "k", pendingTtlMs: 100 })
    if (first.state !== "new") throw new Error("expected a reservation")
    const owner = { namespace: "ns", key: "k", reservation: first.reservation }
    now = 80
    expect(store.renew({ ...owner, ttlMs: 100 })).toBe(true)
    now = 150
    expect(store.begin({ namespace: "ns", key: "k" }).state).toBe("in-flight")
    now = 181
    expect(store.renew({ ...owner, ttlMs: 100 })).toBe(false)
    const second = store.begin({ namespace: "ns", key: "k", pendingTtlMs: 100 })
    if (second.state !== "new") throw new Error("expected the lapsed key to be reserved again")
    expect(store.complete(owner)).toBe(false)
    now = 200
    expect(store.complete({ ...owner, reservation: second.reservation })).toBe(true)
    expect(store.renew({ ...owner, reservation: second.reservation, ttlMs: 100 })).toBe(false)
    now = 1100
    expect(store.begin({ namespace: "ns", key: "k" }).state).toBe("duplicate")
  })

  test("a tool key whose process stopped renewing frees after the lease, not the store's TTL", async () => {
    let now = 1_000_000
    const store = new MemoryToolIdempotencyStore({ now: () => now })
    let executions = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const tool = (block: boolean) =>
      defineTool({
        name: "orders.capture",
        description: "Capture an order.",
        input,
        output,
        capability: "orders.capture",
        idempotency: { scope: "request", key: (value) => value.name },
        execute: async () => {
          executions += 1
          if (block) {
            entered()
            await gate
          }
          return { ok: true }
        },
      })
    const options = { capabilities: ["orders.capture"], idempotency: store }
    // The first call reserves the key and never renews it, as if its process died mid-call.
    const stalled = executeTool(tool(true), { name: "a" }, options)
    await started
    expect(await executeTool(tool(false), { name: "a" }, options)).toMatchObject({
      ok: false,
      error: { code: "idempotency_in_flight" },
    })
    now += 60_001
    expect((await executeTool(tool(false), { name: "a" }, options)).ok).toBe(true)
    expect(executions).toBe(2)
    release()
    expect((await stalled).ok).toBe(false)
  })

  test("a running tool call renews its lease and stops once it settles", async () => {
    const memory = new MemoryToolIdempotencyStore()
    const renewals: number[] = []
    const store: ToolIdempotencyStore = {
      begin: (value) => memory.begin(value),
      complete: (value) => memory.complete(value),
      abandon: (value) => memory.abandon(value),
      renew: (value) => {
        renewals.push(value.ttlMs)
        return memory.renew(value)
      },
    }
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const tool = defineTool({
      name: "orders.slow",
      description: "A slow order operation.",
      input,
      output,
      capability: "orders.slow",
      idempotency: { scope: "request", key: (value) => value.name, pendingTtlMs: 300 },
      execute: async () => {
        entered()
        await new Promise((resolve) => setTimeout(resolve, 700))
        return { ok: true }
      },
    })
    const options = { capabilities: ["orders.slow"], idempotency: store }
    const first = executeTool(tool, { name: "a" }, options)
    await started
    await new Promise((resolve) => setTimeout(resolve, 450))
    // Past the 300ms lease: only the renewals keep a duplicate call from running.
    expect(await executeTool(tool, { name: "a" }, options)).toMatchObject({
      ok: false,
      error: { code: "idempotency_in_flight" },
    })
    expect((await first).ok).toBe(true)
    expect(renewals.length).toBeGreaterThanOrEqual(2)
    expect(new Set(renewals)).toEqual(new Set([300]))
    const settled = renewals.length
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(renewals.length).toBe(settled)
    expect(() =>
      defineTool({
        name: "orders.bad-lease",
        description: "Bad lease.",
        input,
        output,
        idempotency: { scope: "request", key: (value) => value.name, pendingTtlMs: 0 },
        execute: () => ({ ok: true }),
      }),
    ).toThrow(/pendingTtlMs must be a positive integer/)
  })

  test("a tool call whose renewals fail lets its lease lapse, which completion reports", async () => {
    const memory = new MemoryToolIdempotencyStore()
    let attempts = 0
    const store: ToolIdempotencyStore = {
      begin: (value) => memory.begin(value),
      complete: (value) => memory.complete(value),
      abandon: (value) => memory.abandon(value),
      renew: () => {
        attempts += 1
        throw new Error("store unreachable")
      },
    }
    const tool = defineTool({
      name: "orders.flaky",
      description: "An order operation on a flaky store.",
      input,
      output,
      capability: "orders.flaky",
      idempotency: { scope: "request", key: (value) => value.name, pendingTtlMs: 30 },
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 120))
        return { ok: true }
      },
    })
    const result = await executeTool(
      tool,
      { name: "a" },
      { capabilities: ["orders.flaky"], idempotency: store },
    )
    expect(attempts).toBeGreaterThanOrEqual(1)
    expect(result).toMatchObject({ ok: false, error: { code: "idempotency_capacity" } })
  })

  test("fails closed when a required execution policy has no satisfying adapter", async () => {
    let executions = 0
    const tool = defineTool({
      name: "orders.policy",
      description: "Policy-bound order operation.",
      input,
      output,
      capability: "orders.policy",
      policy: {
        filesystem: "declared",
        network: "deny",
        timeMs: 100,
        capabilityCeiling: ["orders.policy"],
      },
      execute: () => {
        executions += 1
        return { ok: true }
      },
    })
    const result = await executeTool(
      tool,
      { name: "a" },
      {
        capabilities: ["orders.policy"],
        executionPolicy: {
          name: "reference",
          canSatisfy: () => false,
          limitations: () => ["unsatisfied"],
        },
      },
    )
    expect(result).toMatchObject({
      ok: false,
      error: { code: "execution_policy_unsatisfied", stage: "policy" },
    })
    expect(executions).toBe(0)
  })

  test("HTTP adapter uses the same contract pipeline", async () => {
    const tool = defineTool({
      name: "orders.http",
      description: "HTTP order operation.",
      input,
      output,
      capability: "orders.http",
      execute: () => ({ ok: true }),
    })
    const handler = createToolHttpHandler(tool, { capabilities: ["orders.http"] })
    const response = await handler(
      new Request("http://test/tool", { method: "POST", body: JSON.stringify({ name: "a" }) }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true })
    const denied = await createToolHttpHandler(tool)(
      new Request("http://test/tool", { method: "POST", body: JSON.stringify({ name: "a" }) }),
    )
    expect(denied.status).toBe(403)
  })

  test("HTTP handler caps the request body at 1 MiB by default", async () => {
    let executions = 0
    const tool = defineTool({
      name: "orders.capped",
      description: "Cap target.",
      input,
      output,
      capability: "orders.capped",
      execute: () => {
        executions += 1
        return { ok: true }
      },
    })
    const handler = createToolHttpHandler(tool, { capabilities: ["orders.capped"] })
    const oversized = JSON.stringify({ name: "a".repeat(DEFAULT_TOOL_MAX_BYTES) })
    const rejected = await handler(
      new Request("http://test/tool", { method: "POST", body: oversized }),
    )
    // Flat 413 before the parse: nothing was admitted, so there is no ledger to seal.
    expect(rejected.status).toBe(413)
    expect(await rejected.text()).toBe("")
    expect(executions).toBe(0)

    // A malformed Content-Length is refused too - the streaming guard is an UPPER bound only, so a
    // lying smaller length would otherwise be read in full.
    const malformedLength = await handler(
      new Request("http://test/tool", {
        method: "POST",
        body: JSON.stringify({ name: "a" }),
        headers: { "content-length": "-1" },
      }),
    )
    expect(malformedLength.status).toBe(400)

    // Under the cap still executes.
    const ok = await handler(
      new Request("http://test/tool", { method: "POST", body: JSON.stringify({ name: "a" }) }),
    )
    expect(ok.status).toBe(200)
    expect(executions).toBe(1)
  })

  test("HTTP handler cap is configurable, and uncapped needs a written reason", () => {
    const tool = defineTool({
      name: "orders.cap-config",
      description: "Cap config target.",
      input,
      output,
      capability: "orders.cap-config",
      execute: () => ({ ok: true }),
    })
    expect(() => createToolHttpHandler(tool, { maxBytes: "unlimited" })).toThrow(
      /requires a non-empty maxBytesReason/,
    )
    expect(() => createToolHttpHandler(tool, { maxBytes: 1024, maxBytesReason: "why" })).toThrow(
      /only valid with maxBytes/,
    )
    expect(() => createToolHttpHandler(tool, { maxBytes: -1 })).toThrow(
      /must be a non-negative safe integer/,
    )
    expect(() =>
      createToolHttpHandler(tool, { maxBytes: "unlimited", maxBytesReason: "streamed uploads" }),
    ).not.toThrow()
  })

  test("HTTP handler rejects a proto-poisoned body exactly like malformed JSON", async () => {
    let executions = 0
    const tool = defineTool({
      name: "orders.poison",
      description: "Poisoning target.",
      input,
      output,
      capability: "orders.poison",
      execute: () => {
        executions += 1
        return { ok: true }
      },
    })
    const handler = createToolHttpHandler(tool, { capabilities: ["orders.poison"] })
    const post = (body: string) =>
      handler(new Request("http://test/tool", { method: "POST", body }))
    const poisoned = await post('{"name": "a", "__proto__": {"admin": true}}')
    const malformed = await post("{not json")
    // Indistinguishable on the wire: same status, same result envelope shape.
    expect(poisoned.status).toBe(malformed.status)
    expect(await poisoned.json()).toMatchObject({
      ok: false,
      error: { code: "input_invalid", stage: "input" },
    })
    expect(executions).toBe(0)
    expect((await post('{"constructor": {"prototype": {"x": 1}}}')).status).toBe(poisoned.status)

    // strip: the poisoned key is deleted and the cleaned input executes normally.
    const stripping = createToolHttpHandler(tool, {
      capabilities: ["orders.poison"],
      protoPoisoning: "strip",
    })
    const stripped = await stripping(
      new Request("http://test/tool", {
        method: "POST",
        body: '{"name": "a", "__proto__": {"admin": true}}',
      }),
    )
    expect(stripped.status).toBe(200)
    expect(executions).toBe(1)
  })

  test("shared adapter conformance checks denial, approval, and dry-run", async () => {
    const tool = defineTool({
      name: "orders.conformance",
      description: "Conformance operation.",
      input,
      output,
      capability: "orders.conformance",
      approval: { kind: "required" },
      execute: () => ({ ok: true }),
    })
    const result = await runToolContractConformance(
      {
        name: "in-process",
        call: (value, options) => executeTool(tool, value, options),
      },
      {
        input: { name: "a" },
        capability: "orders.conformance",
        approval: { granted: true },
        dryRun: {},
      },
    )
    expect(result.checks).toEqual(["capability denial", "approval admission", "dry-run"])
  })
})
