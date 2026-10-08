import { describe, expect, test } from "bun:test"
import {
  AGENT_MAX_EVENT_TEXT,
  AGENT_MAX_PAYLOAD_STRING,
  type AgentEvent,
  isAgentEvent,
} from "@nifrajs/agent-protocol"
import { type NativeMessage, type NativeModelPort, NifraBackend } from "../src/index.ts"

async function run(
  backend: NifraBackend,
  message: string,
  sessionId = "bounds",
): Promise<AgentEvent[]> {
  await backend.createSession({ cwd: process.cwd(), sessionId })
  const events: AgentEvent[] = []
  for await (const event of backend.send({ sessionId, message })) events.push(event)
  return events
}

function replies(events: readonly AgentEvent[]): string[] {
  return events.flatMap((event) => (event.type === "assistant.message" ? [event.text] : []))
}

function last(events: readonly AgentEvent[]): AgentEvent | undefined {
  return events.at(-1)
}

describe("native backend event bounds", () => {
  test("a tool runs with its whole input while the event shows a bounded copy", async () => {
    const content = "y".repeat(100_000)
    let written: unknown
    let calls = 0
    const backend = new NifraBackend({
      model: {
        complete: () =>
          ++calls === 1
            ? { type: "tool", name: "write_file", input: { path: "big.txt", content } }
            : { type: "text", text: "written" },
      },
      tools: [
        {
          name: "write_file",
          description: "Write a file",
          execute: (input) => {
            written = input
            return "ok"
          },
        },
      ],
    })
    const events = await run(backend, "write it")
    expect(last(events)?.type).toBe("session.completed")
    expect(written).toEqual({ path: "big.txt", content })
    const started = events.find((event) => event.type === "tool.started")
    if (started?.type !== "tool.started") throw new Error("expected a tool.started event")
    expect(started.input).toMatchObject({ path: "big.txt" })
    expect(started.input).toHaveProperty("content.length", AGENT_MAX_PAYLOAD_STRING)
    expect(events.every(isAgentEvent)).toBe(true)
  })

  test("a tool call without input still runs", async () => {
    let calls = 0
    const backend = new NifraBackend({
      model: {
        complete: () =>
          ++calls === 1
            ? { type: "tool", name: "ping", input: undefined }
            : { type: "text", text: "pinged" },
      },
      tools: [{ name: "ping", description: "Ping", execute: () => "pong" }],
    })
    const events = await run(backend, "ping")
    expect(last(events)?.type).toBe("session.completed")
    expect(events.find((event) => event.type === "tool.started")).not.toHaveProperty("input")
  })

  test("a reply longer than one event arrives whole across consecutive messages", async () => {
    const text = "r".repeat(AGENT_MAX_EVENT_TEXT * 2 + 5)
    let history: readonly NativeMessage[] = []
    let calls = 0
    const backend = new NifraBackend({
      model: {
        complete: ({ messages }) => {
          history = messages
          return { type: "text", text: ++calls === 1 ? text : "again" }
        },
      },
    })
    const events = await run(backend, "long")
    expect(last(events)?.type).toBe("session.completed")
    expect(replies(events)).toHaveLength(3)
    expect(replies(events).join("")).toBe(text)
    expect(events.every(isAgentEvent)).toBe(true)
    for await (const _ of backend.send({ sessionId: "bounds", message: "next" })) {
    }
    expect(history.find((item) => item.role === "assistant")?.text).toBe(text)
  })

  test("maxReplyChars cuts a reply and its stream with a marker", async () => {
    const model: NativeModelPort = {
      complete: async function* () {
        yield { type: "text_delta", text: "a".repeat(300) }
        yield { type: "text_delta", text: "b".repeat(300) }
        yield { type: "response", response: { type: "text", text: "c".repeat(1_000) } }
      },
    }
    const events = await run(new NifraBackend({ model, maxReplyChars: 400 }), "cut")
    const reply = replies(events).join("")
    expect(reply).toHaveLength(400)
    expect(reply.endsWith("…[truncated]")).toBe(true)
    const streamed = events.flatMap((event) =>
      event.type === "assistant.delta" ? [event.text] : [],
    )
    expect(streamed.join("")).toBe(`${"a".repeat(300)}${"b".repeat(100)}`)
    expect(() => new NifraBackend({ model, maxReplyChars: 255 })).toThrow(RangeError)
  })

  test("a message past one event's text runs, with the event showing a bounded prompt", async () => {
    let received = ""
    const backend = new NifraBackend({
      maxMessageChars: 512 * 1024,
      model: {
        complete: ({ messages }) => {
          received = messages.at(-1)?.text ?? ""
          return { type: "text", text: "read" }
        },
      },
    })
    const message = "p".repeat(300_000)
    const events = await run(backend, message)
    expect(last(events)?.type).toBe("session.completed")
    expect(received).toBe(message)
    const started = events.find((event) => event.type === "turn.started")
    if (started?.type !== "turn.started") throw new Error("expected a turn.started event")
    expect(started.prompt).toHaveLength(AGENT_MAX_EVENT_TEXT)
  })

  test("NUL in a prompt, reply, or tool output does not break the turn", async () => {
    let calls = 0
    const backend = new NifraBackend({
      model: {
        complete: () =>
          ++calls === 1
            ? { type: "tool", name: "read", input: { path: "bin\0ary" } }
            : { type: "text", text: "done\0" },
      },
      tools: [{ name: "read", description: "Read", execute: () => "raw\0bytes" }],
    })
    const events = await run(backend, "read\0it")
    expect(last(events)?.type).toBe("session.completed")
    expect(events.every(isAgentEvent)).toBe(true)
  })

  test("an empty or oddly named failure still ends the turn with a valid event", async () => {
    let calls = 0
    const backend = new NifraBackend({
      model: {
        complete: () => {
          calls += 1
          if (calls === 1) return { type: "tool", name: "not a tool", input: {} }
          if (calls === 2) return { type: "tool", name: "fail", input: {} }
          throw new Error("")
        },
      },
      tools: [
        {
          name: "fail",
          description: "Fail",
          execute: () => {
            throw new Error("")
          },
        },
      ],
    })
    const events = await run(backend, "fail")
    expect(events.every(isAgentEvent)).toBe(true)
    const failures = events.flatMap((event) =>
      event.type === "tool.completed" && !event.ok ? [event] : [],
    )
    expect(failures.map((event) => event.name)).toEqual(["unknown", "fail"])
    expect(failures[1]?.error?.message).toBe("native tool failed")
    const end = last(events)
    if (end?.type !== "session.failed") throw new Error("expected the turn to fail")
    expect(end.error.message).toBe("native turn failed")
  })
})
