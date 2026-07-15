import { describe, expect, test } from "bun:test"
import {
  causalityHeaders,
  continueCausality,
  createMemoryCausalityStore,
  joinCausality,
  parseCausalityContext,
  parseCausalityRecord,
  readCausalityHeaders,
  startCausality,
} from "../src/causality.ts"

describe("execution causality", () => {
  test("builds one deterministic request -> command -> event lineage", () => {
    const request = startCausality("request", "req_1", {
      executionId: "exec_1",
      at: 10,
      trace: { traceId: "a".repeat(32), spanId: "b".repeat(16) },
    })
    const command = continueCausality(request.context, "command", "cmd_1", {
      relation: "caused",
      at: 11,
    })
    const event = continueCausality(command.context, "event", "evt_1", {
      relation: "emitted",
      at: 12,
    })

    expect(request.record).toEqual({
      executionId: "exec_1",
      node: {
        kind: "request",
        id: "req_1",
        at: 10,
        trace: { traceId: "a".repeat(32), spanId: "b".repeat(16) },
      },
      parents: [],
    })
    expect(command.record.parents).toEqual([{ kind: "request", id: "req_1", relation: "caused" }])
    expect(event.context).toEqual({
      executionId: "exec_1",
      current: { kind: "event", id: "evt_1" },
      trace: { traceId: "a".repeat(32), spanId: "b".repeat(16) },
    })
    expect(event.record.parents).toEqual([{ kind: "command", id: "cmd_1", relation: "emitted" }])
    expect(Object.isFrozen(event.record)).toBe(true)
  })

  test("joins parents only inside the same execution", () => {
    const request = startCausality("request", "req_1", { executionId: "exec_1", at: 1 })
    const event = continueCausality(request.context, "event", "evt_1", { at: 2 })
    const timer = continueCausality(request.context, "timer", "timer_1", { at: 2 })

    const workflow = joinCausality([event.context, timer.context], "workflow", "wf_1", {
      relation: "triggered",
      at: 3,
    })
    expect(workflow.record.parents).toEqual([
      { kind: "event", id: "evt_1", relation: "triggered" },
      { kind: "timer", id: "timer_1", relation: "triggered" },
    ])

    const foreign = startCausality("request", "req_2", { executionId: "exec_2", at: 1 })
    expect(() =>
      joinCausality([event.context, foreign.context], "workflow", "wf_bad", { at: 3 }),
    ).toThrow(/same execution/)
  })

  test("round-trips a bounded wire context and rejects payload-shaped input", () => {
    const step = startCausality("request", "req_1", {
      executionId: "exec_1",
      at: 1,
      trace: { traceId: "a".repeat(32), spanId: "b".repeat(16) },
    })

    expect(readCausalityHeaders(new Headers(causalityHeaders(step.context)))).toEqual({
      success: true,
      context: step.context,
    })
    expect(parseCausalityContext(JSON.parse(JSON.stringify(step.context)))).toEqual({
      success: true,
      context: step.context,
    })
    expect(
      parseCausalityContext({
        ...step.context,
        payload: { card: "do-not-accept-arbitrary-data" },
      }),
    ).toEqual({ success: false, reason: "unknown-field" })
    expect(readCausalityHeaders(new Headers({ "x-nifra-execution-id": "exec_1" }))).toEqual({
      success: false,
      reason: "incomplete",
    })
    expect(parseCausalityRecord({ ...step.record, payload: { secret: "no" } })).toEqual({
      success: false,
      reason: "unknown-field",
    })
    expect(
      parseCausalityRecord({
        ...step.record,
        node: { ...step.record.node, metadata: { secret: "no" } },
      }),
    ).toEqual({ success: false, reason: "unknown-field" })
  })

  test("stores an idempotent bounded timeline and rejects identity conflicts", async () => {
    const store = createMemoryCausalityStore({ allowInProduction: true, maxRecords: 3 })
    const root = startCausality("request", "req_1", { executionId: "exec_1", at: 1 })
    const command = continueCausality(root.context, "command", "cmd_1", { at: 2 })
    const event = continueCausality(command.context, "event", "evt_1", { at: 3 })

    expect(await store.record(command.record)).toBe("inserted") // out-of-order is supported
    expect(await store.record(root.record)).toBe("inserted")
    expect(await store.record(command.record)).toBe("duplicate")
    expect(await store.record(event.record)).toBe("inserted")

    const first = await store.timeline("exec_1", { limit: 2 })
    expect(first.items.map((item) => item.record.node.id)).toEqual(["req_1", "cmd_1"])
    expect(first.nextCursor).toBeString()
    if (first.nextCursor === undefined) throw new Error("expected a second timeline page")
    const second = await store.timeline("exec_1", { after: first.nextCursor, limit: 2 })
    expect(second.items.map((item) => item.record.node.id)).toEqual(["evt_1"])
    expect(second.nextCursor).toBeUndefined()

    await expect(
      store.record({
        ...command.record,
        node: { ...command.record.node, at: 99 },
      }),
    ).rejects.toThrow(/conflict/)

    const overflow = startCausality("timer", "timer_1", { executionId: "exec_1", at: 4 })
    await expect(store.record(overflow.record)).rejects.toThrow(/capacity/)
    expect(() =>
      startCausality("request", "fractional", {
        executionId: "exec_fractional",
        at: 1.5,
      }),
    ).toThrow(/safe-integer/)
  })
})
