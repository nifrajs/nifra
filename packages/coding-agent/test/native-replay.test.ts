import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@nifrajs/agent-protocol"
import { NifraBackend, ReplayBackend } from "../src/index.ts"

describe("optional native and replay backends", () => {
  test("runs a streamed native model through a bounded tool loop", async () => {
    let calls = 0
    const backend = new NifraBackend({
      model: {
        complete: async function* ({ messages }) {
          calls += 1
          if (calls === 1) {
            yield { type: "text_delta", text: "checking" }
            yield {
              type: "response",
              response: { type: "tool", name: "inspect", input: { ok: true } },
            }
            return
          }
          expect(messages.at(-1)?.role).toBe("tool")
          yield { type: "response", response: { type: "text", text: "verified" } }
        },
      },
      tools: [
        {
          name: "inspect",
          description: "Inspect a fixture",
          execute: () => ({ inspected: true }),
        },
      ],
    })
    await backend.createSession({ cwd: process.cwd(), sessionId: "native" })
    const events: AgentEvent[] = []
    for await (const event of backend.send({ sessionId: "native", message: "inspect" }))
      events.push(event)
    expect(events.some((event) => event.type === "tool.completed" && event.ok)).toBe(true)
    expect(
      events.some((event) => event.type === "assistant.message" && event.text === "verified"),
    ).toBe(true)
    expect((await backend.snapshot("native")).status).toBe("idle")
    await backend.close("native")
  })

  test("replays recorded protocol events with deterministic session identity", async () => {
    const source: AgentEvent[] = [
      {
        version: 1,
        sessionId: "recorded",
        seq: 0,
        at: 1,
        type: "turn.started",
        turnId: "turn",
        prompt: "hello",
      },
      {
        version: 1,
        sessionId: "recorded",
        seq: 1,
        at: 2,
        type: "assistant.message",
        turnId: "turn",
        text: "world",
      },
    ]
    const backend = new ReplayBackend({ events: source })
    await backend.createSession({ cwd: process.cwd(), sessionId: "replay" })
    const events: AgentEvent[] = []
    for await (const event of backend.send({ sessionId: "replay", message: "ignored" }))
      events.push(event)
    expect(events[0]?.sessionId).toBe("replay")
    expect(
      events.some((event) => event.type === "assistant.message" && event.text === "world"),
    ).toBe(true)
    expect(events.at(-1)?.type).toBe("session.completed")
    await backend.close("replay")
  })
})
