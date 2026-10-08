import { describe, expect, test } from "bun:test"
import {
  AGENT_MAX_EVENT_TEXT,
  AGENT_MAX_PAYLOAD_STRING,
  type AgentEvent,
  isAgentEvent,
} from "@nifrajs/agent-protocol"
import { PiBackend } from "../src/index.ts"

// A fake Pi whose tool call, tool result, and reply are each past what one event may carry.
const script = `
const write = (record) => process.stdout.write(JSON.stringify(record) + "\\n")
process.stdin.on("data", (chunk) => {
  if (!String(chunk).includes("prompt")) return
  const content = "w".repeat(100000)
  write({ type: "tool_execution_start", toolCallId: "call-1", toolName: "write", args: { path: "big.txt", content } })
  write({ type: "tool_execution_update", toolCallId: "call-1", partialResult: { content: [{ type: "text", text: "u".repeat(300000) }] } })
  write({ type: "tool_execution_end", toolCallId: "call-1", toolName: "write", isError: false, result: { content: [{ type: "text", text: "o".repeat(100000) + "\\u0000" }] } })
  write({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "d".repeat(300000) } })
  const reply = { role: "assistant", content: [{ type: "text", text: "r".repeat(300000) }], stopReason: "stop" }
  write({ type: "message_end", message: reply })
  write({ type: "agent_end", messages: [reply] })
})
`

describe("Pi event bounds", () => {
  test("large tool input, tool output, and reply arrive as valid events", async () => {
    const backend = new PiBackend({ command: process.execPath, rpcArgs: ["-e", script] })
    try {
      await backend.createSession({ cwd: process.cwd(), sessionId: "pi-bounds" })
      const events: AgentEvent[] = []
      for await (const event of backend.send({
        sessionId: "pi-bounds",
        message: "write\0it",
      }))
        events.push(event)
      expect(events.at(-1)?.type).toBe("session.completed")
      expect(events.every(isAgentEvent)).toBe(true)

      const started = events.find((event) => event.type === "tool.started")
      if (started?.type !== "tool.started") throw new Error("expected a tool.started event")
      expect(started.input).toMatchObject({ path: "big.txt" })
      expect(started.input).toHaveProperty("content.length", AGENT_MAX_PAYLOAD_STRING)

      const completed = events.find((event) => event.type === "tool.completed")
      if (completed?.type !== "tool.completed") throw new Error("expected a tool.completed event")
      expect(completed.output).toHaveLength(AGENT_MAX_PAYLOAD_STRING)

      const pieces = (type: AgentEvent["type"]): string[] =>
        events.flatMap((event) =>
          event.type === type && "text" in event && typeof event.text === "string"
            ? [event.text]
            : [],
        )
      expect(pieces("tool.delta").join("")).toBe("u".repeat(300_000))
      expect(pieces("assistant.delta").join("")).toBe("d".repeat(300_000))
      const replies = pieces("assistant.message")
      expect(replies).toHaveLength(2)
      expect(replies.join("")).toBe("r".repeat(300_000))
      expect(replies.every((reply) => reply.length <= AGENT_MAX_EVENT_TEXT)).toBe(true)
    } finally {
      await backend.close("pi-bounds")
    }
  })
})
