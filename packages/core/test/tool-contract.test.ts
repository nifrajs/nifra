import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import {
  createToolBudget,
  createToolHttpHandler,
  defineTool,
  executeTool,
  MemoryToolIdempotencyStore,
  runToolContractConformance,
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
