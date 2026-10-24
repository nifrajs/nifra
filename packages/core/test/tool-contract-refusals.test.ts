import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { z } from "zod"
import { createRequestLedger } from "../src/ledger.ts"
import type { StandardSchemaV1 } from "../src/schema/standard.ts"
import {
  createToolBudget,
  createToolHttpHandler,
  defineTool,
  executeTool,
  MemoryToolIdempotencyStore,
  runToolContractConformance,
  type ToolAdapter,
  type ToolCallResult,
  type ToolError,
  type ToolIdempotencyStore,
  toolHttpResult,
  toolInputJsonSchema,
} from "../src/tool-contract.ts"

const input = t.object({ name: t.string({ minLength: 1 }) })
const output = t.object({ ok: t.boolean() })

const base = {
  name: "orders.refuse",
  description: "Refusal fixture.",
  input,
  output,
  capability: "orders.refuse",
  execute: () => ({ ok: true }),
}

const keyed = (scope: "request" | "durable", key = "order-1") =>
  defineTool({ ...base, idempotency: { scope, key: () => key } })

describe("tool budget and idempotency store bounds", () => {
  test("a budget refuses an initial spend past its limit and snapshots a frozen copy", () => {
    expect(() => createToolBudget({ limits: { calls: 1 }, initial: { calls: 2 } })).toThrow(
      "tool budget: initial calls exceeds its limit",
    )
    expect(() => createToolBudget({ limits: { calls: -1 } })).toThrow(/^tool budget limits: /)
    const budget = createToolBudget({ limits: { calls: 2 }, initial: { calls: 1 } })
    expect(budget.consume({ calls: 1 })).toBe(true)
    const snapshot = budget.snapshot()
    expect(snapshot).toEqual({ calls: 2 })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(budget.consume(undefined)).toBe(true)
    expect(budget.consume({ calls: 1 })).toBe(false)
  })

  test("the memory store refuses bad bounds and a malformed namespace or key", () => {
    expect(() => new MemoryToolIdempotencyStore({ maxEntries: 0 })).toThrow(
      "maxEntries must be a positive safe integer",
    )
    expect(() => new MemoryToolIdempotencyStore({ ttlMs: 1.5 })).toThrow(
      "ttlMs must be a positive safe integer",
    )
    const store = new MemoryToolIdempotencyStore()
    expect(() => store.begin({ namespace: "", key: "k" })).toThrow(
      "tool idempotency: namespace/key is invalid",
    )
    expect(() => store.begin({ namespace: "tool", key: "has space" })).toThrow(
      "tool idempotency: namespace/key is invalid",
    )
  })

  test("a completed or unknown reservation cannot be abandoned", () => {
    const store = new MemoryToolIdempotencyStore()
    const began = store.begin({ namespace: "tool", key: "k" })
    if (began.state !== "new") throw new Error("expected a new reservation")
    const reservation = { namespace: "tool", key: "k", reservation: began.reservation }
    expect(store.abandon({ ...reservation, reservation: "someone-else" })).toBe(false)
    expect(store.complete(reservation)).toBe(true)
    expect(store.abandon(reservation)).toBe(false)
    expect(store.begin({ namespace: "tool", key: "k" })).toEqual({ state: "duplicate" })
  })
})

describe("tool contract definition refusals", () => {
  const notSchema = { "~standard": { version: 2, validate: () => ({ value: 1 }) } }
  const cases: readonly [string, unknown, string][] = [
    ["options", null, "tool contract: options must be an object"],
    ["name", { ...base, name: "Orders" }, 'tool contract: invalid name "Orders"'],
    ["description", { ...base, description: "  " }, "description must not be empty"],
    ["input", { ...base, input: notSchema }, "input and output must implement Standard Schema"],
    ["output", { ...base, output: "schema" }, "input and output must implement Standard Schema"],
    ["capability", { ...base, capability: "not a token" }, "invalid capability"],
    ["approval kind", { ...base, approval: { kind: "maybe" } }, "approval policy is invalid"],
    [
      "approval level",
      { ...base, approval: { kind: "threshold", level: 0 } },
      "approval policy is invalid",
    ],
    ["sensitivity", { ...base, sensitivity: "private" }, "tool contract: invalid sensitivity"],
    [
      "idempotency scope",
      { ...base, idempotency: { scope: "none", key: () => "k" } },
      "idempotency scope is invalid",
    ],
    [
      "idempotency key",
      { ...base, idempotency: { scope: "request", key: "k" } },
      "idempotency key must be a function",
    ],
    [
      "idempotency lease",
      { ...base, idempotency: { scope: "request", key: () => "k", pendingTtlMs: 0 } },
      "idempotency pendingTtlMs must be a positive integer",
    ],
    ["execute", { ...base, execute: "run" }, "tool contract: execute must be a function"],
  ]
  for (const [label, options, message] of cases) {
    test(`refuses an invalid ${label}`, () => {
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: deliberately malformed options, to prove the runtime refuses what the type already would.
      expect(() => defineTool(options as Parameters<typeof defineTool>[0])).toThrow(message)
    })
  }

  test("keeps a threshold approval, a cost and annotations", () => {
    const tool = defineTool({
      ...base,
      approval: { kind: "threshold", level: 2 },
      cost: { calls: 1 },
      annotations: { readOnlyHint: true },
    })
    expect(tool.approval).toEqual({ kind: "threshold", level: 2 })
    expect(tool.cost).toEqual({ calls: 1 })
    expect(tool.annotations).toEqual({ readOnlyHint: true })
    expect(Object.isFrozen(tool.annotations)).toBe(true)
  })
})

describe("tool idempotency admission refusals", () => {
  const capabilities = ["orders.refuse"]

  test("a malformed namespace, a missing store and a bad key all refuse before the executor", async () => {
    const store = new MemoryToolIdempotencyStore()
    const badNamespace = await executeTool(
      keyed("request"),
      { name: "a" },
      { capabilities, idempotency: store, namespace: "has space" },
    )
    const missing = await executeTool(keyed("request"), { name: "a" }, { capabilities })
    const badKey = await executeTool(
      keyed("request", ""),
      { name: "a" },
      { capabilities, idempotency: store },
    )
    for (const result of [badNamespace, missing, badKey]) {
      expect(result).toMatchObject({
        ok: false,
        error: { code: "idempotency_store_missing", stage: "idempotency" },
      })
      expect(result.evidence.at(-1)).toMatchObject({
        stage: "idempotency",
        outcome: "denied",
        code: "idempotency_store_missing",
      })
    }
  })

  test("a durable key refuses a memory store and runs on a durable one", async () => {
    const memory = await executeTool(
      keyed("durable"),
      { name: "a" },
      { capabilities, idempotency: new MemoryToolIdempotencyStore() },
    )
    expect(memory).toMatchObject({
      ok: false,
      error: { code: "idempotency_durability", stage: "idempotency" },
    })
    const inner = new MemoryToolIdempotencyStore()
    const durable: ToolIdempotencyStore = {
      durability: "durable",
      begin: (value) => inner.begin(value),
      complete: (value) => inner.complete(value),
      abandon: (value) => inner.abandon(value),
    }
    const ran = await executeTool(
      keyed("durable"),
      { name: "a" },
      { capabilities, idempotency: durable },
    )
    expect(ran).toMatchObject({ ok: true, output: { ok: true } })
  })

  test("an invalid output whose completion the store refuses reports the store", async () => {
    let executions = 0
    const tool = defineTool({
      ...base,
      idempotency: { scope: "request", key: () => "order-1" },
      execute: () => {
        executions += 1
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: deliberately malformed output, to prove the runtime refuses what the type already would.
        return { ok: "yes" } as unknown as { ok: boolean }
      },
    })
    const inner = new MemoryToolIdempotencyStore()
    const refusing: ToolIdempotencyStore = {
      begin: (value) => inner.begin(value),
      complete: () => false,
      abandon: (value) => inner.abandon(value),
    }
    const result = await executeTool(tool, { name: "a" }, { capabilities, idempotency: refusing })
    expect(executions).toBe(1)
    expect(result).toMatchObject({
      ok: false,
      error: { code: "idempotency_capacity", stage: "idempotency" },
    })
    expect(result.evidence.at(-1)).toMatchObject({ stage: "idempotency", outcome: "failed" })
  })
})

describe("tool ledger failure", () => {
  test("a ledger that refuses its entries answers ledger_failed with a fresh sealed ledger", async () => {
    const sealed = createRequestLedger({ method: "TOOL", path: "/orders.refuse", declared: [] })
    await sealed.seal()
    let executions = 0
    const tool = defineTool({
      ...base,
      execute: () => {
        executions += 1
        return { ok: true }
      },
    })
    const result = await executeTool(
      tool,
      { name: "a" },
      { capabilities: ["orders.refuse"], ledger: sealed, clock: () => 7 },
    )
    expect(executions).toBe(0)
    expect(result).toMatchObject({
      ok: false,
      error: { code: "ledger_failed", stage: "execution" },
    })
    expect(result.evidence.at(-1)).toMatchObject({ outcome: "failed", code: "ledger_failed" })
    expect(result.ledger.entries).toEqual([])
  })
})

describe("tool HTTP handler and result mapping", () => {
  const tool = defineTool(base)

  test("answers another method with 405 and its allow header", async () => {
    const handler = createToolHttpHandler(tool, { method: "put", capabilities: ["orders.refuse"] })
    const refused = await handler(new Request("http://test/tool", { method: "POST", body: "{}" }))
    expect(refused.status).toBe(405)
    expect(refused.headers.get("allow")).toBe("PUT")
    const ok = await handler(
      new Request("http://test/tool", { method: "PUT", body: '{"name":"a"}' }),
    )
    expect(ok.status).toBe(200)
  })

  test("an uncapped handler reads the whole body", async () => {
    const handler = createToolHttpHandler(tool, {
      capabilities: ["orders.refuse"],
      maxBytes: "unlimited",
      maxBytesReason: "the gateway caps tool bodies",
      protoPoisoning: "ignore",
    })
    const body = JSON.stringify({ name: "x".repeat(2 * 1_048_576) })
    const response = await handler(new Request("http://test/tool", { method: "POST", body }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, output: { ok: true } })
  })

  test("maps each error code to its status", async () => {
    const ledger = await createRequestLedger({ method: "TOOL", path: "/t", declared: [] }).seal()
    const statusOf = (code: ToolError["code"]) => {
      const result: ToolCallResult<unknown> = {
        ok: false,
        dryRun: false,
        error: { code, stage: "execution" },
        evidence: [],
        ledger,
      }
      const response = toolHttpResult(result)
      return [response.status, response.headers.get("retry-after")]
    }
    expect(statusOf("input_invalid")).toEqual([422, null])
    expect(statusOf("approval_required")).toEqual([403, null])
    expect(statusOf("approval_denied")).toEqual([403, null])
    expect(statusOf("capability_denied")).toEqual([403, null])
    expect(statusOf("idempotency_duplicate")).toEqual([409, null])
    expect(statusOf("idempotency_in_flight")).toEqual([409, "1"])
    expect(statusOf("budget_exceeded")).toEqual([429, null])
    expect(statusOf("idempotency_capacity")).toEqual([503, "1"])
    expect(statusOf("execution_failed")).toEqual([500, null])
    expect(statusOf("ledger_failed")).toEqual([500, null])
  })
})

describe("tool input JSON Schema", () => {
  test("reflects a schema that carries one, and falls back to a closed object", () => {
    expect(toolInputJsonSchema(defineTool(base))).toMatchObject({
      type: "object",
      properties: { name: { type: "string" } },
    })
    const opaque: StandardSchemaV1<unknown, { name: string }> = {
      "~standard": {
        version: 1,
        vendor: "opaque",
        validate: (value) =>
          typeof value === "object" &&
          value !== null &&
          "name" in value &&
          typeof value.name === "string"
            ? { value: { name: value.name } }
            : { issues: [{ message: "name must be a string" }] },
      },
    }
    expect(toolInputJsonSchema(defineTool({ ...base, input: opaque }))).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    })
  })

  test("reads a schema's Standard JSON Schema, so a zod input lists its fields", () => {
    const zodInput = z.object({ name: z.string().min(1) })
    expect(toolInputJsonSchema(defineTool({ ...base, input: zodInput }))).toMatchObject({
      type: "object",
      properties: { name: { type: "string", minLength: 1 } },
      required: ["name"],
    })
  })
})

describe("tool adapter conformance refusals", () => {
  const options = {
    input: { name: "a" },
    capability: "orders.refuse",
    approval: { granted: true } as const,
    dryRun: {},
  }
  const adapterFor = (call: ToolAdapter["call"]): ToolAdapter => ({ name: "broken", call })
  const approved = defineTool({ ...base, approval: { kind: "required" } })

  test("refuses an adapter without a call function", async () => {
    await expect(
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: deliberately malformed adapter, to prove the runtime refuses what the type already would.
      runToolContractConformance({ name: "none" } as unknown as ToolAdapter, options),
    ).rejects.toThrow("tool conformance: adapter must be callable")
  })

  test("refuses an adapter that ignores the capability list", async () => {
    await expect(
      runToolContractConformance(
        adapterFor((value) => executeTool(approved, value, { capabilities: ["orders.refuse"] })),
        options,
      ),
    ).rejects.toThrow("tool conformance: capability denial failed")
  })

  test("refuses an adapter that drops the approval", async () => {
    await expect(
      runToolContractConformance(
        adapterFor((value, call) =>
          executeTool(approved, value, { capabilities: call?.capabilities ?? [] }),
        ),
        options,
      ),
    ).rejects.toThrow("tool conformance: approval was not supplied")
  })

  test("refuses an adapter that runs a dry run for real", async () => {
    await expect(
      runToolContractConformance(
        adapterFor((value, call) => executeTool(approved, value, { ...call, dryRun: false })),
        options,
      ),
    ).rejects.toThrow("tool conformance: dry-run failed")
  })
})
