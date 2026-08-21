import { expect, test } from "bun:test"
import type { NifraSpan, ObservationAdapter } from "@nifrajs/otel"
import { orchestrationTelemetry } from "../src/index.ts"

const digest = "d".repeat(64)

test("orchestration telemetry correlates retries and recovery without payload fields", () => {
  const spans: NifraSpan[] = []
  const telemetry = orchestrationTelemetry({
    exporter: { onEnd: (span) => spans.push(span) },
  })
  expect(telemetry.enabled).toBe(true)
  expect(
    telemetry.record({
      kind: "retrying",
      runId: "run-1",
      planDigest: digest,
      nodeId: "node-1",
      attempt: 2,
      evidenceSeq: 4,
      at: 10,
      replayId: "replay-1",
      traceRef: "trace-1",
      scheduleToken: "job:2",
      statusCode: "effect_rejected",
    }),
  ).toBe(true)
  expect(
    telemetry.record({
      kind: "recovered",
      runId: "run-1",
      planDigest: digest,
      nodeId: "node-1",
      attempt: 2,
      evidenceSeq: 5,
      at: 20,
      replayId: "replay-1",
      traceRef: "trace-1",
      scheduleToken: "job:3",
    }),
  ).toBe(true)
  telemetry.close()
  expect(spans.map((span) => span.name)).toEqual([
    "nifra.orchestration.retrying",
    "nifra.orchestration.recovered",
    "nifra.orchestration.run",
  ])
  expect(spans[0]?.attributes["nifra.orchestration.node_id"]).toBe("node-1")
  expect(JSON.stringify(spans)).not.toMatch(/prompt|message|input|output|secret|path/i)
})

test("telemetry rejects unknown/content attributes and bounds cardinality", () => {
  const adapter: ObservationAdapter = { onEnd: () => undefined }
  const telemetry = orchestrationTelemetry({ exporter: adapter, maxDistinctValues: 1 })
  const base = {
    kind: "started",
    runId: "run",
    planDigest: digest,
    nodeId: "node",
    attempt: 1,
    evidenceSeq: 0,
    at: 0,
  }
  expect(telemetry.record({ ...base, prompt: "never" })).toBe(false)
  expect(telemetry.record({ ...base, evidenceId: "first" })).toBe(true)
  expect(telemetry.record({ ...base, evidenceSeq: 1, evidenceId: "second" })).toBe(false)
  expect(telemetry.dropped).toBeGreaterThanOrEqual(2)
  telemetry.close()
})

test("telemetry is off by default", () => {
  const telemetry = orchestrationTelemetry()
  expect(telemetry.enabled).toBe(false)
  expect(telemetry.record({})).toBe(false)
  expect(telemetry.dropped).toBe(0)
})
