import { describe, expect, test } from "bun:test"
import { continueCausality } from "@nifrajs/core/causality"
import type { StandardSchemaV1 } from "@nifrajs/core/schema"
import { server } from "@nifrajs/core/server"
import { createEventRegistry, defineEventContract, type EventEnvelope } from "@nifrajs/events"
import { traceEventConsumer } from "../src/events.ts"
import type { ObservationContext } from "../src/lifecycle.ts"
import type { NifraSpan } from "../src/span.ts"
import { tracing } from "../src/tracing.ts"

function collect(): { spans: NifraSpan[]; exporter: { onEnd(span: NifraSpan): void } } {
  const spans: NifraSpan[] = []
  return { spans, exporter: { onEnd: (span) => spans.push(span) } }
}

type Paid = { orderId: string; card: string }
const paidSchema: StandardSchemaV1<Paid, Paid> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => {
      const v = value as Partial<Paid> | null
      return typeof v?.orderId === "string" && typeof v.card === "string"
        ? { value: v as Paid }
        : { issues: [{ message: "orderId and card are required" }, { message: "second" }] }
    },
  },
}
const orderPaid = defineEventContract({ type: "order.paid", version: 1, payload: paidSchema })

const AMBIENT: ObservationContext = {
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  sampled: true,
  traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
}

describe("traceEventConsumer", () => {
  test("a consumer span per envelope, linked to the request that produced it through causality", async () => {
    const { spans, exporter } = collect()
    let produced: EventEnvelope<Paid> | undefined
    const app = server()
      .use(tracing({ exporter }))
      .post("/pay", (c) => {
        const id = `evt_${crypto.randomUUID()}`
        const { context } = continueCausality(c.causality, "event", id, { relation: "emitted" })
        produced = orderPaid.create(
          { orderId: "o-1", card: "4111111111111111" },
          {
            id,
            causality: context,
          },
        )
        return { ok: true }
      })
    await app.fetch(new Request("http://nifra.test/pay", { method: "POST" }))

    let seen: ObservationContext | undefined
    const consume = traceEventConsumer(
      orderPaid,
      (event, ctx) => {
        seen = ctx.trace
        return event.payload.orderId
      },
      { exporter },
    )
    const result = await consume(JSON.parse(JSON.stringify(produced)))
    expect(result).toEqual({ success: true, value: "o-1" })

    const request = spans.find((span) => span.name === "POST /pay") as NifraSpan
    const process = spans.find((span) => span.name === "process order.paid") as NifraSpan
    expect(process.kind).toBe("consumer")
    expect(process.parentSpanId).toBeUndefined()
    expect(process.traceId).not.toBe(request.traceId)
    expect(process.links?.[0]).toMatchObject({ traceId: request.traceId, spanId: request.spanId })
    expect(process.attributes).toEqual({
      "messaging.system": "nifra.events",
      "messaging.operation.type": "process",
      "messaging.operation.name": "process",
      "messaging.message.id": produced?.id as string,
      "nifra.event.type": "order.paid",
      "nifra.event.version": 1,
    })
    expect(seen?.spanId).toBe(process.spanId)
    expect(JSON.stringify(spans)).not.toContain("4111111111111111")
  })

  test("with an ambient parent the span is its child; an envelope without causality has no link", async () => {
    const { spans, exporter } = collect()
    const consume = traceEventConsumer(orderPaid, () => "done", { exporter, system: "sqs" })
    const envelope = orderPaid.create({ orderId: "o-2", card: "x" })
    expect(await consume(envelope, AMBIENT)).toEqual({ success: true, value: "done" })
    expect(spans[0]).toMatchObject({
      traceId: AMBIENT.traceId,
      parentSpanId: AMBIENT.spanId,
      attributes: { "messaging.system": "sqs" },
    })
    expect(spans[0]?.links).toBeUndefined()
  })

  test("a contract parse failure is an error span with an issue count and no payload", async () => {
    const { spans, exporter } = collect()
    let called = false
    const consume = traceEventConsumer(
      orderPaid,
      () => {
        called = true
      },
      { exporter },
    )
    const result = await consume({
      id: "evt_1",
      type: "order.paid",
      version: 1,
      occurredAt: new Date().toISOString(),
      payload: { orderId: 7, card: "4111111111111111" },
    })
    expect(result).toEqual({ success: false, issueCount: 2 })
    expect(called).toBe(false)
    expect(spans[0]).toMatchObject({
      name: "process order.paid",
      kind: "consumer",
      status: "error",
      attributes: { "nifra.event.issue_count": 2, "error.type": "invalid_event" },
    })
    expect(JSON.stringify(spans)).not.toContain("4111111111111111")
    expect(JSON.stringify(spans)).not.toContain("evt_1")
  })

  test("a registry failure names no attacker-chosen type and keeps only a bounded reason", async () => {
    const { spans, exporter } = collect()
    const registry = createEventRegistry([orderPaid])
    const consume = traceEventConsumer(registry, () => "never", { exporter })
    expect(await consume({ type: "evil.<script>", version: 1 })).toEqual({
      success: false,
      issueCount: 1,
    })
    expect(spans[0]).toMatchObject({
      name: "process",
      attributes: { "nifra.event.parse_failure": "unknown-contract" },
    })
    expect(JSON.stringify(spans)).not.toContain("evil")

    const odd = traceEventConsumer(
      { parse: () => ({ success: false, reason: "free text from somewhere" }) },
      () => "never",
      { exporter },
    )
    await odd({})
    expect(spans[1]?.attributes["nifra.event.parse_failure"]).toBeUndefined()
  })

  test("a throwing handler ends its span as an error without the message, and rejects", async () => {
    const { spans, exporter } = collect()
    const consume = traceEventConsumer(
      orderPaid,
      () => {
        throw new Error("customer 4111111111111111 declined")
      },
      { exporter },
    )
    await expect(consume(orderPaid.create({ orderId: "o", card: "c" }))).rejects.toThrow("declined")
    expect(spans[0]).toMatchObject({ status: "error", attributes: { "error.type": "_OTHER" } })
    expect(JSON.stringify(spans)).not.toContain("declined")
  })

  test("a parse that throws (an async payload schema) is an error span and rethrows", async () => {
    const { spans, exporter } = collect()
    const asyncSchema: StandardSchemaV1 = {
      "~standard": { version: 1, vendor: "test", validate: async (value) => ({ value }) },
    }
    const contract = defineEventContract({ type: "slow.event", version: 0, payload: asyncSchema })
    const consume = traceEventConsumer(contract, () => "never", { exporter })
    await expect(
      consume({ id: "e", type: "slow.event", version: 0, occurredAt: new Date().toISOString() }),
    ).rejects.toThrow(/async payload schemas/)
    expect(spans[0]).toMatchObject({ name: "process slow.event", status: "error" })
  })

  test("scope runs the handler with the consumer span's context", async () => {
    const { spans, exporter } = collect()
    const scoped: string[] = []
    const consume = traceEventConsumer(orderPaid, async () => "ok", {
      exporter,
      scope: (trace, run) => {
        scoped.push(trace.spanId)
        return run()
      },
    })
    await consume(orderPaid.create({ orderId: "o", card: "c" }))
    expect(scoped).toEqual([spans[0]?.spanId as string])
  })
})
