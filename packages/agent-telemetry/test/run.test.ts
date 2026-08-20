import { describe, expect, test } from "bun:test"
import type { NifraSpan, ObservationAdapter } from "@nifrajs/otel"
import { type AgentRunEvidence, traceAgentRun } from "../src/index.ts"

function collectingExporter(): { exporter: ObservationAdapter; spans: NifraSpan[] } {
  const spans: NifraSpan[] = []
  return {
    spans,
    exporter: {
      onEnd(span) {
        spans.push(span)
      },
    },
  }
}

function evidence(overrides: Partial<AgentRunEvidence>): AgentRunEvidence {
  return { seq: 0, at: 0, kind: "model", outcome: "started", ...overrides }
}

describe("traceAgentRun", () => {
  test("pairs model evidence into one timed span and ends the run span last", () => {
    const { exporter, spans } = collectingExporter()
    const trace = traceAgentRun({ agent: "reference-agent", turnId: "turn-1", exporter })

    trace.telemetry.step(evidence({ seq: 0, outcome: "started" }))
    trace.telemetry.step(evidence({ seq: 1, outcome: "passed" }))
    trace.end({ status: "completed" })

    expect(spans.map((s) => s.name)).toEqual(["nifra.agent.model", "nifra.agent.run"])
    const model = spans[0] as NifraSpan
    expect(model.status).toBe("ok")
    expect(model.attributes["nifra.agent.evidence.seq"]).toBe(1)
    const run = spans[1] as NifraSpan
    expect(run.attributes["nifra.agent.name"]).toBe("reference-agent")
    expect(run.attributes["nifra.agent.turn_id"]).toBe("turn-1")
    expect(run.attributes["nifra.agent.status"]).toBe("completed")
    expect(run.status).toBe("ok")
    expect(model.traceId).toBe(run.traceId)
    expect(model.parentSpanId).toBe(run.spanId)
  })

  test("terminal-only evidence becomes an instant child carrying effect id and ledger head", () => {
    const { exporter, spans } = collectingExporter()
    const trace = traceAgentRun({ agent: "a", turnId: "t", exporter })

    trace.telemetry.step(
      evidence({
        seq: 2,
        kind: "tool",
        outcome: "committed",
        name: "search.read",
        effectId: "eff-1",
        ledgerHead: "head-1",
      }),
    )
    trace.telemetry.step(
      evidence({ seq: 3, kind: "budget", outcome: "denied", code: "budget_exceeded" }),
    )
    trace.end({ status: "completed" })

    const tool = spans.find((s) => s.name === "nifra.agent.tool") as NifraSpan
    expect(tool.status).toBe("ok")
    expect(tool.attributes["tool.name"]).toBe("search.read")
    expect(tool.attributes["nifra.effect.id"]).toBe("eff-1")
    expect(tool.attributes["nifra.ledger.head"]).toBe("head-1")
    const budget = spans.find((s) => s.name === "nifra.agent.budget") as NifraSpan
    expect(budget.status).toBe("error")
    expect(budget.attributes["nifra.agent.error_code"]).toBe("budget_exceeded")
  })

  test("records a typed turn error and a suspension reason on the run span", () => {
    const failed = collectingExporter()
    const failedTrace = traceAgentRun({ agent: "a", turnId: "t1", exporter: failed.exporter })
    failedTrace.end({ status: "completed", error: { code: "output_invalid" } })
    const failedRun = failed.spans[0] as NifraSpan
    expect(failedRun.status).toBe("error")
    expect(failedRun.attributes["nifra.agent.error_code"]).toBe("output_invalid")

    const suspended = collectingExporter()
    const suspendedTrace = traceAgentRun({ agent: "a", turnId: "t2", exporter: suspended.exporter })
    suspendedTrace.end({ status: "suspended", reason: "approval" })
    const suspendedRun = suspended.spans[0] as NifraSpan
    expect(suspendedRun.status).toBe("ok")
    expect(suspendedRun.attributes["nifra.agent.pending_reason"]).toBe("approval")
  })

  test("a run that threw closes the open model span and marks the run as error", () => {
    const { exporter, spans } = collectingExporter()
    const trace = traceAgentRun({ agent: "a", turnId: "t", exporter })
    trace.telemetry.step(evidence({ seq: 0, outcome: "started" }))
    trace.end()
    trace.end({ status: "completed" })

    expect(spans.map((s) => s.name)).toEqual(["nifra.agent.model", "nifra.agent.run"])
    const run = spans[1] as NifraSpan
    expect(run.status).toBe("error")
    expect(run.attributes["nifra.agent.status"]).toBe("threw")
    // The second end() was ignored - exactly-once.
    expect(spans.length).toBe(2)
  })

  test("nests the run under a supplied parent and never throws on a failing adapter", () => {
    const throwing: ObservationAdapter = {
      onEnd() {
        throw new Error("exporter down")
      },
    }
    const trace = traceAgentRun({
      agent: "a",
      turnId: "t",
      exporter: throwing,
      parent: {
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        sampled: true,
      },
    })
    expect(trace.context.traceId).toBe("0af7651916cd43dd8448eb211c80319c")
    expect(trace.context.parentSpanId).toBe("b7ad6b7169203331")
    expect(() => {
      trace.telemetry.step(evidence({ seq: 0, kind: "state", outcome: "suspended" }))
      trace.end({ status: "completed" })
    }).not.toThrow()
  })
})
