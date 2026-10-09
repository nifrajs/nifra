import { describe, expect, test } from "bun:test"
import {
  AGENT_PROTOCOL_VERSION,
  type AgentEvent,
  agentEventProblem,
  createAgentEventStream,
  isAgentEvent,
  isAgentExtensionEventType,
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

  test("rejects an unbounded live event queue configuration", () => {
    expect(() => createAgentEventStream(65_537)).toThrow(/between 1 and 65536/)
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

  test("rejects malformed event-specific payloads before projection", () => {
    expect(
      isAgentEvent({
        version: 1,
        sessionId: "x",
        seq: 1,
        at: 1,
        type: "assistant.delta",
        turnId: "turn",
        text: null,
      }),
    ).toBe(false)
    expect(
      isAgentEvent({
        version: 1,
        sessionId: "x",
        seq: 1,
        at: 1,
        type: "session.updated",
        snapshot: { version: 1, id: "x", status: "running" },
      }),
    ).toBe(false)
    expect(
      isAgentEvent({
        version: 1,
        sessionId: "x",
        seq: 1,
        at: 1,
        type: "tool.completed",
        turnId: "turn",
        callId: "call",
        name: "tool",
        ok: false,
        error: { code: "failed", message: null },
      }),
    ).toBe(false)
  })

  test("a problem names the field and the limit, never the content", () => {
    const base = { version: 1, sessionId: "s", seq: 0, at: 0 }
    const prompt = `secret-${"a".repeat(256 * 1024)}`
    expect(agentEventProblem({ ...base, type: "turn.started", turnId: "t", prompt })).toBe(
      "turn.started.prompt is longer than 262144 characters",
    )
    expect(
      agentEventProblem({
        ...base,
        type: "tool.completed",
        turnId: "t",
        callId: "c",
        name: "write",
        ok: false,
        error: { code: "E", message: "" },
      }),
    ).toBe("tool.completed.error.message must not be empty")
    expect(agentEventProblem({ ...base, type: "plan.updated" })).toBe(
      "unknown event type plan.updated",
    )
    expect(agentEventProblem({ ...base, type: "secret value!" })).toBe("unknown event type")
    expect(agentEventProblem({ ...base, seq: -1, type: "session.stopped" })).toBe(
      "seq must be a non-negative safe integer",
    )
    expect(agentEventProblem(event(1))).toBeUndefined()
  })

  test("x-<vendor>.<name> events pass with bounded data and an optional turn", () => {
    const base = { version: 1, sessionId: "s", seq: 0, at: 0 }
    expect(
      isAgentEvent({ ...base, type: "x-codex.plan", turnId: "t", data: { steps: ["a", "b"] } }),
    ).toBe(true)
    expect(isAgentEvent({ ...base, type: "x-acme-labs.context.usage" })).toBe(true)
    expect(agentEventProblem({ ...base, type: "x-codex.plan", data: "a".repeat(70_000) })).toMatch(
      /^x-codex\.plan\.data is outside the payload bounds/,
    )
    expect(agentEventProblem({ ...base, type: "x-codex.plan", turnId: "" })).toMatch(
      /^x-codex\.plan\.turnId must be/,
    )
    for (const type of [
      "x-Codex.plan",
      "x-codex",
      "x-.plan",
      "x-codex..plan",
      `x-a.${"b".repeat(61)}`,
    ])
      expect(agentEventProblem({ ...base, type })).toMatch(/^extension event type must be/)
    expect(isAgentExtensionEventType("x-codex.plan")).toBe(true)
    expect(isAgentExtensionEventType(`x-a.${"b".repeat(60)}`)).toBe(true)
    expect(isAgentExtensionEventType("turn.started")).toBe(false)
  })
})
