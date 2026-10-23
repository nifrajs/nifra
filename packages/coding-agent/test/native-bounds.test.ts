import { describe, expect, test } from "bun:test"
import { FakeModelGateway } from "@nifrajs/agent"
import {
  AGENT_MAX_EVENT_TEXT,
  AGENT_MAX_PAYLOAD_STRING,
  type AgentEvent,
  isAgentEvent,
} from "@nifrajs/agent-protocol"
import {
  createNativeGatewayModelPort,
  type NativeMessage,
  type NativeModelPort,
  type NativeModelRequest,
  NifraBackend,
} from "../src/index.ts"

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

  test("reasoning and usage chunks become reasoning.delta and context.usage events", async () => {
    const model: NativeModelPort = {
      complete: async function* () {
        yield { type: "reasoning_delta", text: "think", itemId: "r1" }
        yield { type: "reasoning_delta", text: "more", itemId: "not a token!" }
        yield { type: "usage", usedTokens: 1200, windowTokens: 200_000, inputTokens: 1000 }
        yield { type: "usage", usedTokens: -1 }
        yield { type: "usage", usedTokens: 5, outputTokens: 1.5, estimated: true }
        yield { type: "response", response: { type: "text", text: "done" } }
      },
    }
    const events = await run(new NifraBackend({ model }), "think")
    const picked = events.flatMap((event): unknown[] =>
      event.type === "reasoning.delta"
        ? [{ text: event.text, itemId: event.itemId }]
        : event.type === "context.usage"
          ? [{ used: event.usedTokens, window: event.windowTokens, out: event.outputTokens }]
          : [],
    )
    expect(picked).toEqual([
      { text: "think", itemId: "r1" },
      { text: "more", itemId: undefined },
      { used: 1200, window: 200_000, out: undefined },
      { used: 5, window: undefined, out: undefined },
    ])
    expect(
      events.find((event) => event.type === "context.usage" && event.usedTokens === 5),
    ).toMatchObject({
      estimated: true,
    })
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

describe("native backend option bounds", () => {
  const model: NativeModelPort = { complete: () => ({ type: "text", text: "ok" }) }

  test("the constructor refuses a step or message limit out of range", () => {
    expect(() => new NifraBackend({ model, maxSteps: 0 })).toThrow(
      "maxSteps must be between 1 and 512",
    )
    expect(() => new NifraBackend({ model, maxMessageChars: 255 })).toThrow(
      "maxMessageChars must be at least 256",
    )
  })

  test("createSession refuses an empty cwd, odd capabilities and an unbounded id", async () => {
    const backend = new NifraBackend({ model })
    await expect(backend.createSession({ cwd: "" })).rejects.toThrow(
      "cwd must be a bounded non-empty path",
    )
    await expect(
      backend.createSession({ cwd: process.cwd(), capabilities: ["not a token"] }),
    ).rejects.toThrow("capabilities must be bounded tokens")
    await expect(
      backend.createSession({ cwd: process.cwd(), sessionId: "not valid" }),
    ).rejects.toThrow("sessionId must be a bounded token")
  })

  test("a message past maxMessageChars fails the turn before the model runs", async () => {
    let calls = 0
    const backend = new NifraBackend({
      model: {
        complete: () => {
          calls++
          return { type: "text", text: "ok" }
        },
      },
      maxMessageChars: 256,
    })
    await backend.createSession({ cwd: process.cwd(), sessionId: "long" })
    const events = backend.send({ sessionId: "long", message: "x".repeat(257) })
    await expect(events[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "MESSAGE_BOUNDED",
    })
    expect(calls).toBe(0)
  })
})

describe("native gateway model port", () => {
  const request = (): NativeModelRequest => ({
    sessionId: "gateway",
    cwd: process.cwd(),
    messages: [{ role: "user", text: "hi" }],
    tools: [],
    signal: new AbortController().signal,
  })
  const portFor = (output: unknown, routeId?: string) =>
    createNativeGatewayModelPort({
      gateway: new FakeModelGateway({ responses: [{ ok: true, output }] }),
      policy: { routes: ["primary"], retryableCodes: [] },
      ...(routeId === undefined ? {} : { routeId }),
    })

  test("passes a text or a tool response through", async () => {
    expect(await portFor({ type: "text", text: "hello" }).complete(request())).toEqual({
      type: "text",
      text: "hello",
    })
    expect(
      await portFor({ type: "tool", name: "read", input: { path: "a.ts" } }, "primary").complete(
        request(),
      ),
    ).toEqual({ type: "tool", name: "read", input: { path: "a.ts" } })
  })

  test("a response of neither shape fails with the gateway's code", async () => {
    for (const output of ["text", [], { type: "text" }, { type: "tool", name: "read" }])
      await expect(Promise.resolve(portFor(output).complete(request()))).rejects.toThrow(
        "native gateway failed: malformed_output",
      )
  })
})
