import { describe, expect, test } from "bun:test"
import { continueCausality, startCausality } from "@nifrajs/core/causality"
import { t } from "@nifrajs/schema"
import { createEventRegistry, defineEventContract, EventContractError } from "../src/index.ts"

const OrderPaid = defineEventContract({
  type: "order.paid",
  version: 1,
  payload: t.object({ orderId: t.string(), cents: t.number() }),
})

describe("@nifrajs/events — defineEventContract", () => {
  test("rejects an invalid type or version at definition time", () => {
    expect(() =>
      defineEventContract({ type: "Order Paid", version: 1, payload: t.object({}) }),
    ).toThrow(/invalid type/)
    expect(() =>
      defineEventContract({ type: "order.paid", version: -1, payload: t.object({}) }),
    ).toThrow(/non-negative integer/)
    expect(() =>
      defineEventContract({ type: "order.paid", version: 1.5, payload: t.object({}) }),
    ).toThrow(/non-negative integer/)
  })

  test("create validates the payload and stamps a full envelope", () => {
    const env = OrderPaid.create({ orderId: "o_1", cents: 500 })
    expect(env.type).toBe("order.paid")
    expect(env.version).toBe(1)
    expect(env.id).toMatch(/^evt_/)
    expect(Number.isNaN(Date.parse(env.occurredAt))).toBe(false)
    expect(env.payload).toEqual({ orderId: "o_1", cents: 500 })
  })

  test("create honours explicit id/occurredAt overrides (e.g. deterministic replay)", () => {
    const env = OrderPaid.create(
      { orderId: "o_2", cents: 10 },
      { id: "evt_fixed", occurredAt: "2026-07-13T00:00:00.000Z" },
    )
    expect(env.id).toBe("evt_fixed")
    expect(env.occurredAt).toBe("2026-07-13T00:00:00.000Z")
  })

  test("carries validated causal lineage across the durable event boundary", () => {
    const request = startCausality("request", "req_1", { executionId: "exec_1", at: 1 })
    const command = continueCausality(request.context, "command", "cmd_1", { at: 2 })
    const event = continueCausality(command.context, "event", "evt_fixed", {
      relation: "emitted",
      at: 3,
    })
    const envelope = OrderPaid.create(
      { orderId: "o_1", cents: 500 },
      { id: "evt_fixed", causality: event.context },
    )

    expect(envelope.causality).toEqual(event.context)
    expect(OrderPaid.parse(JSON.parse(JSON.stringify(envelope))).success).toBe(true)
    expect(
      OrderPaid.parse({
        ...envelope,
        causality: { ...event.context, payload: { secret: "not lineage" } },
      }).success,
    ).toBe(false)
  })

  test("create throws EventContractError on an invalid payload", () => {
    expect(() => OrderPaid.create({ orderId: "o_1", cents: "nope" } as never)).toThrow(
      EventContractError,
    )
    try {
      OrderPaid.create({ orderId: 1 } as never)
    } catch (err) {
      expect(err).toBeInstanceOf(EventContractError)
      expect((err as EventContractError).type).toBe("order.paid")
      expect((err as EventContractError).issues.length).toBeGreaterThan(0)
    }
  })

  test("the produced envelope is frozen", () => {
    const env = OrderPaid.create({ orderId: "o_1", cents: 1 })
    expect(Object.isFrozen(env)).toBe(true)
  })
})

describe("@nifrajs/events — parse (untrusted input)", () => {
  const valid = OrderPaid.create({ orderId: "o_1", cents: 1 })

  test("round-trips a valid envelope", () => {
    const result = OrderPaid.parse(JSON.parse(JSON.stringify(valid)))
    expect(result.success).toBe(true)
    if (result.success) expect(result.envelope.payload.orderId).toBe("o_1")
  })

  test("rejects non-objects", () => {
    expect(OrderPaid.parse(null).success).toBe(false)
    expect(OrderPaid.parse("x").success).toBe(false)
  })

  test("rejects a wrong type or version", () => {
    expect(OrderPaid.parse({ ...valid, type: "order.refunded" }).success).toBe(false)
    expect(OrderPaid.parse({ ...valid, version: 2 }).success).toBe(false)
  })

  test("rejects a bad occurredAt and missing id", () => {
    expect(OrderPaid.parse({ ...valid, occurredAt: "not-a-date" }).success).toBe(false)
    expect(OrderPaid.parse({ ...valid, id: "" }).success).toBe(false)
  })

  test("rejects an invalid payload and roots issues under `payload`", () => {
    const result = OrderPaid.parse({ ...valid, payload: { orderId: "o_1", cents: "bad" } })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.issues[0]?.path?.[0]).toBe("payload")
  })

  test("is() is the boolean guard", () => {
    expect(OrderPaid.is(JSON.parse(JSON.stringify(valid)))).toBe(true)
    expect(OrderPaid.is({ ...valid, version: 9 })).toBe(false)
  })
})

describe("@nifrajs/events — registry", () => {
  const OrderPaidV2 = defineEventContract({
    type: "order.paid",
    version: 2,
    payload: t.object({ orderId: t.string(), cents: t.number(), currency: t.string() }),
  })
  const registry = createEventRegistry([OrderPaid, OrderPaidV2])

  test("throws on duplicate type@version", () => {
    expect(() => createEventRegistry([OrderPaid, OrderPaid])).toThrow(/duplicate contract/)
  })

  test("dispatches to the right contract by type+version", () => {
    const v1 = OrderPaid.create({ orderId: "o_1", cents: 5 })
    const r1 = registry.parse(JSON.parse(JSON.stringify(v1)))
    expect(r1.success).toBe(true)
    if (r1.success) expect(r1.contract.version).toBe(1)

    const v2 = OrderPaidV2.create({ orderId: "o_1", cents: 5, currency: "usd" })
    const r2 = registry.parse(JSON.parse(JSON.stringify(v2)))
    expect(r2.success).toBe(true)
    if (r2.success) expect(r2.contract.version).toBe(2)
  })

  test("fails closed on an unknown contract", () => {
    const result = registry.parse({
      id: "evt_x",
      type: "ghost.event",
      version: 1,
      occurredAt: new Date().toISOString(),
      payload: {},
    })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.reason).toBe("unknown-contract")
  })

  test("surfaces an invalid payload distinctly from an unknown contract", () => {
    const bad = {
      id: "evt_x",
      type: "order.paid",
      version: 1,
      occurredAt: new Date().toISOString(),
      payload: { orderId: 1 },
    }
    const result = registry.parse(bad)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.reason).toBe("invalid-payload")
  })

  test("get() looks up by type + version (defaulting to 0)", () => {
    expect(registry.get("order.paid", 2)?.version).toBe(2)
    expect(registry.get("order.paid")).toBeUndefined() // no version-0 contract
  })
})
