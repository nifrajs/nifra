import { expect, test } from "bun:test"
import { startCausality } from "@nifrajs/core/causality"
import { causalitySpanLink, createObservationLifecycle, type NifraSpan } from "../src/index.ts"

test("a durable causal parent becomes a real OTel span link", () => {
  const parent = startCausality("event", "evt_1", {
    executionId: "exec_1",
    at: 1,
    trace: { traceId: "a".repeat(32), spanId: "b".repeat(16) },
  })
  const ended: NifraSpan[] = []
  const lifecycle = createObservationLifecycle({
    adapters: [{ onEnd: (span) => ended.push(span) }],
    generateTraceId: () => "c".repeat(32),
    generateSpanId: () => "d".repeat(16),
  })

  const link = causalitySpanLink(parent.context)
  const span = lifecycle.start({ name: "workflow resume", links: link ? [link] : [] }).end()

  expect(span.links).toEqual([
    {
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      attributes: {
        "nifra.execution.id": "exec_1",
        "nifra.causality.kind": "event",
        "nifra.causality.id": "evt_1",
      },
    },
  ])
  expect(Object.isFrozen(span.links)).toBe(true)
  expect(ended).toEqual([span])
})

test("an unobserved causal parent produces no fake OTel link", () => {
  const parent = startCausality("event", "evt_1", { executionId: "exec_1", at: 1 })
  expect(causalitySpanLink(parent.context)).toBeUndefined()
})

test("invalid typed input is dropped instead of becoming an unbounded span link", () => {
  expect(
    causalitySpanLink({
      executionId: "exec",
      current: { kind: "event", id: "evt" },
      trace: { traceId: "not-w3c", spanId: "also-bad" },
    }),
  ).toBeUndefined()
})
