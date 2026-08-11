import { describe, expect, test } from "bun:test"
import { createAgentEvidenceStream } from "../src/events.ts"
import type { AgentStepEvidence } from "../src/index.ts"

const evidence = (seq: number): AgentStepEvidence => ({
  seq,
  at: seq,
  kind: "state",
  outcome: "committed",
})

describe("agent evidence stream", () => {
  test("preserves exact evidence ordering and terminates after complete", async () => {
    const stream = createAgentEvidenceStream()
    const first = stream.next()
    const one = evidence(1)
    const two = evidence(2)
    stream.step(one)
    stream.step(two)
    stream.complete()

    expect(await first).toEqual({ done: false, value: one })
    expect(await stream.next()).toEqual({ done: false, value: two })
    expect(await stream.next()).toEqual({ done: true, value: undefined })
  })

  test("bounds queued evidence and ignores steps after completion", async () => {
    const stream = createAgentEvidenceStream({ maxQueueSize: 1 })
    stream.step(evidence(1))
    // A stalled consumer must never throw into the turn it observes: the oldest item is dropped and
    // counted, and `seq` leaves the gap visible.
    stream.step(evidence(2))
    expect(stream.dropped).toBe(1)
    stream.complete()
    stream.step(evidence(3))
    expect(await stream.next()).toEqual({ done: false, value: evidence(2) })
    expect(await stream.next()).toEqual({ done: true, value: undefined })
  })
})
