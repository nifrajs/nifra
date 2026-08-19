import { describe, expect, test } from "bun:test"
import {
  AGENT_PROTOCOL_VERSION,
  type AgentEvent,
  createAgentEventStream,
  isAgentEvent,
} from "../src/index.ts"

function event(seq: number): AgentEvent {
  return {
    version: AGENT_PROTOCOL_VERSION,
    sessionId: "session",
    seq,
    at: seq,
    type: "assistant.delta",
    turnId: "turn",
    text: String(seq),
  }
}

describe("agent protocol", () => {
  test("bounds live event queues and reports drops", async () => {
    const stream = createAgentEventStream(2)
    stream.push(event(0))
    stream.push(event(1))
    stream.push(event(2))
    expect(stream.dropped).toBe(1)
    expect((await stream.next()).value?.seq).toBe(1)
    expect((await stream.next()).value?.seq).toBe(2)
    stream.complete()
    expect((await stream.next()).done).toBe(true)
  })

  test("delivers an event directly to a waiting consumer", async () => {
    const stream = createAgentEventStream()
    const next = stream.next()
    stream.push(event(3))
    expect((await next).value?.seq).toBe(3)
  })

  test("rejects a waiting consumer when the stream fails", async () => {
    const stream = createAgentEventStream()
    const next = stream.next()
    stream.fail(new Error("transport failed"))
    await expect(next).rejects.toThrow("transport failed")
  })

  test("recognizes versioned protocol events", () => {
    expect(isAgentEvent(event(0))).toBe(true)
    expect(isAgentEvent({ version: 2, sessionId: "x", seq: 0, at: 0, type: "x.y" })).toBe(false)
    expect(isAgentEvent({ version: 1, sessionId: "x", seq: 0, at: 0 })).toBe(false)
  })

  test("accepts approval resolution events as versioned events", () => {
    expect(
      isAgentEvent({
        version: 1,
        sessionId: "x",
        seq: 1,
        at: 1,
        type: "approval.resolved",
        approvalId: "a",
        approved: true,
      }),
    ).toBe(true)
  })
})
