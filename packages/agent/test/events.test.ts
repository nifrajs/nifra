import { describe, expect, test } from "bun:test"
import {
  createAgentEvidenceStream,
  createMemoryAgentEvidenceLog,
  scopeAgentEvidenceLog,
} from "../src/events.ts"
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
  test("a scoped view keeps each owner's turns apart, whatever the owner spells", async () => {
    const log = createMemoryAgentEvidenceLog()
    const alice = scopeAgentEvidenceLog(log, "alice")
    await alice.open("turn-1").step(evidence(1))
    await alice.finish("turn-1", "alice's")

    expect(await scopeAgentEvidenceLog(log, "bob").replay("turn-1", 0)).toBeUndefined()
    expect(await scopeAgentEvidenceLog(log, "alice/turn-1").replay("turn-1", 0)).toBeUndefined()
    expect(await log.replay("turn-1", 0)).toBeUndefined()
    expect(await (await alice.replay("turn-1", 0))?.result).toBe("alice's")
    expect(() => scopeAgentEvidenceLog(log, "")).toThrow(TypeError)
  })

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

  test("a returned live replay stops receiving evidence", async () => {
    const log = createMemoryAgentEvidenceLog()
    const port = log.open("turn-returned")
    let visits = 0
    for (let i = 0; i < 100; i++) {
      const live = (await log.replay("turn-returned", 0))?.live
      if (live === undefined) throw new Error("expected live replay")
      const step = live.step.bind(live)
      live.step = (item) => {
        visits++
        step(item)
      }
      await live.return?.()
    }
    await port.step(evidence(1))
    expect(visits).toBe(0)
  })

  test("live replays per running turn are capped, ending the oldest", async () => {
    const log = createMemoryAgentEvidenceLog({ maxSubscribers: 2 })
    const port = log.open("turn-capped")
    const views = []
    for (let i = 0; i < 3; i++) {
      const live = (await log.replay("turn-capped", 0))?.live
      if (live === undefined) throw new Error("expected live replay")
      views.push(live)
    }
    await port.step(evidence(1))
    expect(await views[0]?.next()).toEqual({ done: true, value: undefined })
    expect(await views[2]?.next()).toEqual({ done: false, value: evidence(1) })
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

  test("a turn reopened again and again keeps only its newest evidence", async () => {
    const log = createMemoryAgentEvidenceLog({ maxTurns: 1, maxEvidencePerTurn: 4 })
    for (let seq = 0; seq < 10; seq++) {
      await log.open("turn-reused").step(evidence(seq))
      await log.finish("turn-reused", seq)
    }
    const replay = await log.replay("turn-reused", 5)
    expect(replay?.evidence.map((item) => item.seq)).toEqual([6, 7, 8, 9])
    expect(await replay?.result).toBe(9)
    // Replaying from an older cursor would skip the dropped items, so it is unavailable instead.
    expect(await log.replay("turn-reused", 4)).toBeUndefined()
    expect(await log.replay("turn-reused", -1)).toBeUndefined()
  })

  test("per-turn evidence is bounded by default and the bound is validated", async () => {
    const log = createMemoryAgentEvidenceLog({ maxTurns: 1 })
    const total = 3000
    for (let seq = 0; seq < total; seq++) {
      await log.open("turn-long").step(evidence(seq))
      await log.finish("turn-long", undefined)
    }
    const replay = await log.replay("turn-long", total - 1025)
    expect(replay?.evidence).toHaveLength(1024)
    expect(await log.replay("turn-long", total - 1026)).toBeUndefined()
    expect(() => createMemoryAgentEvidenceLog({ maxEvidencePerTurn: 0 })).toThrow(RangeError)
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

  test("eviction prefers a finished turn and ends a running turn's rejoined replays", async () => {
    const log = createMemoryAgentEvidenceLog({ maxTurns: 2 })
    log.open("running")
    log.open("done")
    await log.finish("done", "ok")
    log.open("next")
    expect(await log.replay("done", 0)).toBeUndefined()

    const replay = await log.replay("running", 0)
    if (replay === undefined || replay.live === undefined) throw new Error("expected live replay")
    log.open("last")
    expect(await log.replay("running", 0)).toBeUndefined()
    expect(await replay.live.next()).toEqual({ done: true, value: undefined })
    expect(await replay.result).toBeUndefined()
  })
})
