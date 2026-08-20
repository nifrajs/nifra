import { describe, expect, test } from "bun:test"
import { createAgentEvidenceStream, createMemoryAgentEvidenceLog } from "../src/events.ts"
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

describe("memory agent evidence log", () => {
  test("replays evidence after a seq cursor and resolves the stored result", async () => {
    const log = createMemoryAgentEvidenceLog()
    const port = log.open("turn-1")
    await port.step(evidence(1))
    await port.step(evidence(2))
    await log.finish("turn-1", { event: "result", data: { ok: true } })

    const replay = await log.replay("turn-1", 1)
    expect(replay).toBeDefined()
    expect(replay?.evidence.map((item) => item.seq)).toEqual([2])
    expect(replay?.live).toBeUndefined()
    expect(await replay?.result).toEqual({ event: "result", data: { ok: true } })
    expect(await log.replay("unknown", 0)).toBeUndefined()
  })

  test("a live replay receives later evidence and completes at finish", async () => {
    const log = createMemoryAgentEvidenceLog()
    const port = log.open("turn-live")
    await port.step(evidence(1))

    const replay = await log.replay("turn-live", 0)
    if (replay === undefined || replay.live === undefined) throw new Error("expected live replay")
    expect(replay.evidence.map((item) => item.seq)).toEqual([1])

    await port.step(evidence(2))
    await log.finish("turn-live", "done")
    expect(await replay.live.next()).toEqual({ done: false, value: evidence(2) })
    expect(await replay.live.next()).toEqual({ done: true, value: undefined })
    expect(await replay.result).toBe("done")
  })

  test("reopening a finished turn appends evidence and defers a fresh result", async () => {
    const log = createMemoryAgentEvidenceLog()
    const first = log.open("turn-resume")
    await first.step(evidence(1))
    await log.finish("turn-resume", "suspended")

    const second = log.open("turn-resume")
    await second.step(evidence(2))
    await log.finish("turn-resume", "completed")

    const replay = await log.replay("turn-resume", 0)
    expect(replay?.evidence.map((item) => item.seq)).toEqual([1, 2])
    expect(await replay?.result).toBe("completed")
  })

  test("evicts the oldest turn once maxTurns is reached", async () => {
    const log = createMemoryAgentEvidenceLog({ maxTurns: 2 })
    log.open("a")
    log.open("b")
    log.open("c")
    expect(await log.replay("a", 0)).toBeUndefined()
    expect(await log.replay("b", 0)).toBeDefined()
    expect(await log.replay("c", 0)).toBeDefined()
    expect(() => createMemoryAgentEvidenceLog({ maxTurns: 0 })).toThrow(RangeError)
  })
})
