import { describe, expect, test } from "bun:test"
import type { AgentDefinition, AgentModelPort, AgentPorts } from "@nifrajs/agent"
import { MemoryAgentStateStore } from "@nifrajs/agent"
import { createMemoryAgentEvidenceLog } from "@nifrajs/agent/events"
import { defineTool } from "@nifrajs/core/tool-contract"
import { t } from "@nifrajs/schema"
import { type AgUIMountableApp, type AgUIRouteContext, mountAgUI } from "../src/index.ts"

const input = t.object({ prompt: t.string() })
const output = t.object({ answer: t.string() })

const echoTool = defineTool({
  name: "reference.echo",
  description: "Echo a reference value.",
  input: t.object({ value: t.string() }),
  output: t.object({ value: t.string() }),
  capability: "reference.echo",
  execute: (toolInput) => ({ value: toolInput.value }),
})

const approvalTool = defineTool({
  name: "reference.approve",
  description: "Run an approved reference action.",
  input: t.object({ value: t.string() }),
  output: t.object({ ok: t.boolean() }),
  capability: "reference.approve",
  approval: { kind: "required" },
  execute: () => ({ ok: true }),
})

function definition(
  tools: AgentDefinition<typeof input, typeof output>["tools"] = [],
): AgentDefinition<typeof input, typeof output> {
  return {
    name: "reference-agent",
    instruction: "Return a concise answer.",
    input,
    output,
    tools,
  }
}

function captureApp(): {
  readonly app: AgUIMountableApp
  call(req: Request): Promise<Response>
} {
  let handler: ((c: AgUIRouteContext) => Response | Promise<Response>) | undefined
  return {
    app: {
      post: (_path, h) => {
        handler = h
      },
    },
    call: (req) => {
      if (handler === undefined) throw new Error("no handler mounted")
      return Promise.resolve(handler({ req }))
    },
  }
}

function outputModel(value: unknown): AgentModelPort {
  return { complete: () => ({ kind: "output", value }) }
}

function toolThenOutputModel(tool: string, toolInput: unknown, value: unknown): AgentModelPort {
  let calls = 0
  return {
    complete: () => {
      calls += 1
      if (calls === 1) return { kind: "tool", name: tool, input: toolInput }
      return { kind: "output", value }
    },
  }
}

function runInput(extra: Record<string, unknown> = {}): Request {
  return new Request("http://local/agui", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId: "thread-1", runId: "run-1", ...extra }),
  })
}

function ports(overrides: Partial<AgentPorts> = {}): (c: AgUIRouteContext) => AgentPorts {
  return () => ({ model: outputModel({ answer: "hi" }), capabilities: [], ...overrides })
}

async function events(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text()
  return text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice("data: ".length)) as Record<string, unknown>)
}

function types(list: readonly Record<string, unknown>[]): string[] {
  return list.map((event) => event.type as string)
}

describe("mountAgUI", () => {
  test("streams the run lifecycle with a text message and RUN_FINISHED", async () => {
    const { app, call } = captureApp()
    mountAgUI(app, { agent: definition(), ports: ports() })

    const res = await call(runInput({ forwardedProps: { input: { prompt: "hey" } } }))
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const list = await events(res)
    const sequence = types(list)
    expect(sequence[0]).toBe("RUN_STARTED")
    expect(sequence).toContain("TEXT_MESSAGE_START")
    expect(sequence).toContain("TEXT_MESSAGE_CONTENT")
    expect(sequence).toContain("TEXT_MESSAGE_END")
    expect(sequence.at(-1)).toBe("RUN_FINISHED")
    const started = list[0] as { threadId: string; runId: string }
    expect(started.threadId).toBe("thread-1")
    expect(started.runId).toBe("run-1")
    const content = list.find((e) => e.type === "TEXT_MESSAGE_CONTENT") as { delta: string }
    expect(JSON.parse(content.delta)).toEqual({ answer: "hi" })
    const finished = list.at(-1) as { result: unknown }
    expect(finished.result).toEqual({ answer: "hi" })
  })

  test("announces the turn id in a CUSTOM event", async () => {
    const { app, call } = captureApp()
    mountAgUI(app, { agent: definition(), ports: ports() })

    const list = await events(await call(runInput({ forwardedProps: { input: { prompt: "x" } } })))
    const custom = list.find((e) => e.type === "CUSTOM" && e.name === "nifra.turn") as {
      value: { turnId: string }
    }
    expect(custom.value.turnId).toBe("run-1")
  })

  test("maps tool evidence to TOOL_CALL_START, TOOL_CALL_END, and a token-only TOOL_CALL_RESULT", async () => {
    const { app, call } = captureApp()
    mountAgUI(app, {
      agent: definition([echoTool]),
      ports: ports({
        model: toolThenOutputModel("reference.echo", { value: "x" }, { answer: "done" }),
        capabilities: ["reference.echo"],
      }),
    })

    const list = await events(await call(runInput({ forwardedProps: { input: { prompt: "x" } } })))
    const start = list.find((e) => e.type === "TOOL_CALL_START") as {
      toolCallId: string
      toolCallName: string
      timestamp: number
    }
    expect(start.toolCallName).toBe("reference.echo")
    expect(typeof start.timestamp).toBe("number")
    const end = list.find((e) => e.type === "TOOL_CALL_END") as { toolCallId: string }
    expect(end.toolCallId).toBe(start.toolCallId)
    const result = list.find((e) => e.type === "TOOL_CALL_RESULT") as {
      toolCallId: string
      messageId: string
      role: string
      content: string
    }
    expect(result.toolCallId).toBe(start.toolCallId)
    expect(result.role).toBe("tool")
    expect(result.messageId).toMatch(/^run-1:tool:\d+$/)
    expect(JSON.parse(result.content)).toEqual({ outcome: "committed" })
  })

  test("carries the failure code in TOOL_CALL_RESULT when a tool fails", async () => {
    const failingTool = defineTool({
      name: "reference.fail",
      description: "Always fail.",
      input: t.object({ value: t.string() }),
      output: t.object({ value: t.string() }),
      capability: "reference.fail",
      execute: () => {
        throw new Error("boom")
      },
    })
    const { app, call } = captureApp()
    mountAgUI(app, {
      agent: definition([failingTool]),
      ports: ports({
        model: toolThenOutputModel("reference.fail", { value: "x" }, { answer: "recovered" }),
        capabilities: ["reference.fail"],
      }),
    })

    const list = await events(await call(runInput({ forwardedProps: { input: { prompt: "x" } } })))
    const result = list.find((e) => e.type === "TOOL_CALL_RESULT") as { content: string }
    const content = JSON.parse(result.content) as { outcome: string; code?: string }
    expect(content.outcome).toBe("failed")
  })

  test("marks a successful completion with outcome success", async () => {
    const { app, call } = captureApp()
    mountAgUI(app, { agent: definition(), ports: ports() })

    const list = await events(await call(runInput({ forwardedProps: { input: { prompt: "x" } } })))
    const finished = list.at(-1) as { outcome: { type: string }; timestamp: number }
    expect(finished.outcome).toEqual({ type: "success" })
    expect(typeof finished.timestamp).toBe("number")
    expect(types(list)).not.toContain("MESSAGES_SNAPSHOT")
  })

  test("emits a MESSAGES_SNAPSHOT with the assistant output when opted in", async () => {
    const { app, call } = captureApp()
    const seen: unknown[] = []
    const model: AgentModelPort = {
      complete: (request) => {
        seen.push(request.input)
        return { kind: "output", value: { answer: "ok" } }
      },
    }
    mountAgUI(app, { agent: definition(), ports: ports({ model }), emitMessagesSnapshot: true })

    const clientMessages = [{ id: "m1", role: "user", content: "hey" }]
    const list = await events(
      await call(
        runInput({ messages: clientMessages, forwardedProps: { input: { prompt: "hey" } } }),
      ),
    )
    const sequence = types(list)
    expect(sequence.indexOf("MESSAGES_SNAPSHOT")).toBeGreaterThan(
      sequence.indexOf("TEXT_MESSAGE_END"),
    )
    expect(sequence.indexOf("MESSAGES_SNAPSHOT")).toBeLessThan(sequence.indexOf("RUN_FINISHED"))
    const snapshot = list.find((e) => e.type === "MESSAGES_SNAPSHOT") as {
      messages: { id: string; role: string; content: string }[]
    }
    expect(snapshot.messages).toHaveLength(2)
    expect(snapshot.messages[0]).toEqual(clientMessages[0])
    expect(snapshot.messages[1]?.role).toBe("assistant")
    expect(snapshot.messages[1]?.id).toBe("run-1:output")
    expect(JSON.parse(snapshot.messages[1]?.content ?? "")).toEqual({ answer: "ok" })
  })

  test("takes input from the last user message when forwardedProps has none", async () => {
    const { app, call } = captureApp()
    const seen: unknown[] = []
    const model: AgentModelPort = {
      complete: (request) => {
        seen.push(request.input)
        return { kind: "output", value: { answer: "ok" } }
      },
    }
    const stringInput = { ...definition(), input: t.string() }
    mountAgUI(app, { agent: stringInput, ports: ports({ model }) })

    await events(
      await call(
        runInput({
          messages: [
            { id: "m1", role: "user", content: "first" },
            { id: "m2", role: "assistant", content: "reply" },
            { id: "m3", role: "user", content: "latest question" },
          ],
        }),
      ),
    )
    expect(seen).toEqual(["latest question"])
  })

  test("reports a failed completion as RUN_ERROR", async () => {
    const { app, call } = captureApp()
    mountAgUI(app, { agent: definition(), ports: ports({ model: outputModel({ wrong: true }) }) })

    const list = await events(await call(runInput({ forwardedProps: { input: { prompt: "x" } } })))
    const error = list.find((e) => e.type === "RUN_ERROR") as { message: string }
    expect(error.message).toBe("output_invalid")
    expect(types(list)).not.toContain("RUN_FINISHED")
  })

  test("suspends with a pending continuation and resumes through forwardedProps", async () => {
    const { app, call } = captureApp()
    const store = new MemoryAgentStateStore()
    const agent = definition([approvalTool])
    const base = {
      capabilities: ["reference.approve"],
      state: store,
    }
    mountAgUI(app, {
      agent,
      ports: ports({
        ...base,
        model: toolThenOutputModel("reference.approve", { value: "x" }, { answer: "approved" }),
        approval: { request: ({ effectId }) => ({ status: "pending", effectId }) },
      }),
    })

    const first = await events(
      await call(runInput({ forwardedProps: { input: { prompt: "go" } } })),
    )
    const pending = first.find((e) => e.type === "CUSTOM" && e.name === "nifra.pending") as {
      value: { turnId: string; reason: string; continuation: { effectId: string } }
    }
    expect(pending.value.reason).toBe("approval")
    expect(types(first).at(-1)).toBe("RUN_FINISHED")
    const firstFinished = first.at(-1) as {
      outcome: {
        type: string
        interrupts: {
          id: string
          reason: string
          toolCallId?: string
          responseSchema: unknown
          metadata: { turnId: string; continuation: { effectId: string } }
        }[]
      }
    }
    expect(firstFinished.outcome.type).toBe("interrupt")
    const interrupt = firstFinished.outcome.interrupts[0]
    expect(interrupt?.id).toBe(pending.value.turnId)
    expect(interrupt?.reason).toBe("approval")
    expect(interrupt?.toolCallId).toBe(pending.value.continuation.effectId)
    expect(interrupt?.responseSchema).toBeDefined()
    expect(interrupt?.metadata.continuation).toEqual(pending.value.continuation)

    const second = await events(
      await call(
        runInput({
          runId: "run-2",
          forwardedProps: {
            input: { prompt: "go" },
            turnId: pending.value.turnId,
            resume: {
              continuation: { ...pending.value.continuation, input: { value: "x" } },
              approval: { granted: true },
            },
          },
        }),
      ),
    )
    const finished = second.find((e) => e.type === "RUN_FINISHED") as { result: unknown }
    expect(finished.result).toEqual({ answer: "approved" })
  })

  test("resumes through the spec resume array without forwardedProps", async () => {
    const { app, call } = captureApp()
    const store = new MemoryAgentStateStore()
    mountAgUI(app, {
      agent: definition([approvalTool]),
      ports: ports({
        capabilities: ["reference.approve"],
        state: store,
        model: toolThenOutputModel("reference.approve", { value: "x" }, { answer: "approved" }),
        approval: { request: ({ effectId }) => ({ status: "pending", effectId }) },
      }),
    })

    const first = await events(
      await call(runInput({ forwardedProps: { input: { prompt: "go" } } })),
    )
    const finished = first.at(-1) as {
      outcome: {
        interrupts: { id: string; metadata: { continuation: { effectId: string } } }[]
      }
    }
    const interrupt = finished.outcome.interrupts[0]
    if (interrupt === undefined) throw new Error("no interrupt emitted")

    const second = await events(
      await call(
        runInput({
          runId: "run-2",
          forwardedProps: { input: { prompt: "go" } },
          resume: [
            {
              interruptId: interrupt.id,
              status: "resolved",
              payload: {
                continuation: { ...interrupt.metadata.continuation, input: { value: "x" } },
                approval: { granted: true },
              },
            },
          ],
        }),
      ),
    )
    const done = second.find((e) => e.type === "RUN_FINISHED") as { result: unknown }
    expect(done.result).toEqual({ answer: "approved" })
  })

  test("treats a cancelled resume entry without an approval as a denial", async () => {
    const { app, call } = captureApp()
    const store = new MemoryAgentStateStore()
    mountAgUI(app, {
      agent: definition([approvalTool]),
      ports: ports({
        capabilities: ["reference.approve"],
        state: store,
        model: toolThenOutputModel("reference.approve", { value: "x" }, { answer: "moved on" }),
        approval: { request: ({ effectId }) => ({ status: "pending", effectId }) },
      }),
    })

    const first = await events(
      await call(runInput({ forwardedProps: { input: { prompt: "go" } } })),
    )
    const finished = first.at(-1) as {
      outcome: {
        interrupts: { id: string; metadata: { continuation: { effectId: string } } }[]
      }
    }
    const interrupt = finished.outcome.interrupts[0]
    if (interrupt === undefined) throw new Error("no interrupt emitted")

    const second = await events(
      await call(
        runInput({
          runId: "run-2",
          forwardedProps: { input: { prompt: "go" } },
          resume: [
            {
              interruptId: interrupt.id,
              status: "cancelled",
              payload: {
                continuation: { ...interrupt.metadata.continuation, input: { value: "x" } },
              },
            },
          ],
        }),
      ),
    )
    // The denial resumes the turn instead of suspending again; the model completes it.
    expect(second.some((e) => e.type === "CUSTOM" && e.name === "nifra.pending")).toBe(false)
    const denied = second.find((e) => e.type === "TOOL_CALL_RESULT") as
      | { content: string }
      | undefined
    if (denied !== undefined) {
      // The runner records the denial as approval evidence and the tool effect as failed.
      expect(["denied", "failed"]).toContain(
        (JSON.parse(denied.content) as { outcome: string }).outcome,
      )
    }
    expect(types(second).at(-1)).toBe("RUN_FINISHED")
  })

  test("rejects a body without threadId and runId", async () => {
    const { app, call } = captureApp()
    mountAgUI(app, { agent: definition(), ports: ports() })

    const res = await call(
      new Request("http://local/agui", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: "run-1" }),
      }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()) as Record<string, unknown>).toEqual({
      error: "invalid_run_agent_input",
    })
  })
})

describe("mountAgUI resumable streams", () => {
  function replayInput(headers: Record<string, string>): Request {
    return new Request("http://local/agui", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        threadId: "thread-1",
        runId: "run-1",
        forwardedProps: { input: { prompt: "hey" } },
      }),
    })
  }

  function framed(text: string): { ids: string[]; types: string[] } {
    const ids: string[] = []
    const eventTypes: string[] = []
    for (const chunk of text.split("\n\n")) {
      const id = chunk.match(/^id: (\d+)$/m)
      if (id?.[1] !== undefined) ids.push(id[1])
      const data = chunk.match(/^data: (.+)$/m)
      if (data?.[1] !== undefined)
        eventTypes.push((JSON.parse(data[1]) as Record<string, unknown>).type as string)
    }
    return { ids, types: eventTypes }
  }

  test("stamps evidence frames with ids and replays a finished run from Last-Event-ID", async () => {
    const { app, call } = captureApp()
    mountAgUI(app, {
      agent: definition(),
      ports: ports(),
      evidenceLog: createMemoryAgentEvidenceLog(),
    })

    const first = framed(await (await call(replayInput({}))).text())
    expect(first.ids.length).toBeGreaterThan(0)
    expect(first.types).toContain("RUN_FINISHED")

    const replay = await call(replayInput({ "last-event-id": "0" }))
    expect(replay.headers.get("content-type")).toContain("text/event-stream")
    const replayed = framed(await replay.text())
    expect(replayed.types[0]).toBe("RUN_STARTED")
    expect(replayed.types).toContain("TEXT_MESSAGE_CONTENT")
    expect(replayed.types[replayed.types.length - 1]).toBe("RUN_FINISHED")
  })

  test("rejects an unknown replay and a malformed Last-Event-ID", async () => {
    const { app, call } = captureApp()
    mountAgUI(app, {
      agent: definition(),
      ports: ports(),
      evidenceLog: createMemoryAgentEvidenceLog(),
    })

    const unknown = await call(replayInput({ "last-event-id": "5" }))
    expect(unknown.status).toBe(409)
    expect((await unknown.json()) as Record<string, unknown>).toEqual({
      error: "replay_unavailable",
    })

    const malformed = await call(replayInput({ "last-event-id": "nope" }))
    expect(malformed.status).toBe(400)
  })
})

describe("mountAgUI model deltas", () => {
  test("streams text deltas live and suppresses the duplicate terminal text block", async () => {
    const { app, call } = captureApp()
    const model: AgentModelPort = {
      complete: (request) => {
        request.onDelta?.({ kind: "text", text: "he" })
        request.onDelta?.({ kind: "text", text: "llo" })
        return { kind: "output", value: { answer: "hello" } }
      },
    }
    mountAgUI(app, { agent: definition(), ports: ports({ model }) })

    const list = await events(await call(runInput({ forwardedProps: { input: { prompt: "x" } } })))
    const sequence = types(list)
    const starts = list.filter((e) => e.type === "TEXT_MESSAGE_START")
    expect(starts).toHaveLength(1)
    expect((starts[0] as { messageId: string }).messageId).toBe("run-1:stream:0")
    expect((starts[0] as { role: string }).role).toBe("assistant")
    const contents = list.filter((e) => e.type === "TEXT_MESSAGE_CONTENT") as {
      messageId: string
      delta: string
    }[]
    expect(contents.map((e) => e.delta)).toEqual(["he", "llo"])
    expect(contents.every((e) => e.messageId === "run-1:stream:0")).toBe(true)
    expect(sequence.filter((type) => type === "TEXT_MESSAGE_END")).toHaveLength(1)
    expect(sequence.indexOf("TEXT_MESSAGE_END")).toBeLessThan(sequence.indexOf("RUN_FINISHED"))
    const finished = list.at(-1) as { type: string; result: unknown }
    expect(finished.type).toBe("RUN_FINISHED")
    expect(finished.result).toEqual({ answer: "hello" })
  })

  test("streams reasoning deltas as a REASONING message and keeps the terminal text block", async () => {
    const { app, call } = captureApp()
    const model: AgentModelPort = {
      complete: (request) => {
        request.onDelta?.({ kind: "reasoning", text: "thinking " })
        request.onDelta?.({ kind: "reasoning", text: "hard" })
        return { kind: "output", value: { answer: "done" } }
      },
    }
    mountAgUI(app, { agent: definition(), ports: ports({ model }) })

    const list = await events(await call(runInput({ forwardedProps: { input: { prompt: "x" } } })))
    const sequence = types(list)
    for (const type of [
      "REASONING_START",
      "REASONING_MESSAGE_START",
      "REASONING_MESSAGE_CONTENT",
      "REASONING_MESSAGE_END",
      "REASONING_END",
    ])
      expect(sequence).toContain(type)
    const messageStart = list.find((e) => e.type === "REASONING_MESSAGE_START") as {
      messageId: string
      role: string
    }
    expect(messageStart.role).toBe("reasoning")
    const contents = list.filter((e) => e.type === "REASONING_MESSAGE_CONTENT") as {
      delta: string
    }[]
    expect(contents.map((e) => e.delta)).toEqual(["thinking ", "hard"])
    // No text was streamed, so the terminal TEXT_MESSAGE block still carries the output.
    expect(sequence).toContain("TEXT_MESSAGE_CONTENT")
    expect(sequence.at(-1)).toBe("RUN_FINISHED")
  })

  test("streams tool args on a provisional call that the tool evidence closes", async () => {
    const { app, call } = captureApp()
    let calls = 0
    const model: AgentModelPort = {
      complete: (request) => {
        calls += 1
        if (calls === 1) {
          request.onDelta?.({ kind: "tool-args", name: "reference.echo", argsText: '{"value"' })
          request.onDelta?.({ kind: "tool-args", argsText: ':"x"}' })
          return { kind: "tool", name: "reference.echo", input: { value: "x" } }
        }
        return { kind: "output", value: { answer: "done" } }
      },
    }
    mountAgUI(app, {
      agent: definition([echoTool]),
      ports: ports({ model, capabilities: ["reference.echo"] }),
    })

    const list = await events(await call(runInput({ forwardedProps: { input: { prompt: "x" } } })))
    const starts = list.filter((e) => e.type === "TOOL_CALL_START") as {
      toolCallId: string
      toolCallName: string
    }[]
    expect(starts).toHaveLength(1)
    expect(starts[0]?.toolCallId).toBe("run-1:call:0")
    expect(starts[0]?.toolCallName).toBe("reference.echo")
    const args = list.filter((e) => e.type === "TOOL_CALL_ARGS") as {
      toolCallId: string
      delta: string
    }[]
    expect(args.map((e) => e.delta)).toEqual(['{"value"', ':"x"}'])
    expect(args.every((e) => e.toolCallId === "run-1:call:0")).toBe(true)
    const ends = list.filter((e) => e.type === "TOOL_CALL_END") as { toolCallId: string }[]
    expect(ends).toHaveLength(1)
    expect(ends[0]?.toolCallId).toBe("run-1:call:0")
    const result = list.find((e) => e.type === "TOOL_CALL_RESULT") as {
      toolCallId: string
      content: string
    }
    expect(result.toolCallId).toBe("run-1:call:0")
    expect(JSON.parse(result.content)).toEqual({ outcome: "committed" })
    // Only tool args were streamed; the terminal text block still carries the output.
    expect(types(list)).toContain("TEXT_MESSAGE_CONTENT")
  })
})

describe("mountAgUI usage", () => {
  test("sums usage deltas across model decisions onto RUN_FINISHED and keeps them on replay", async () => {
    const { app, call } = captureApp()
    let calls = 0
    const model: AgentModelPort = {
      complete: (request) => {
        calls += 1
        if (calls === 1) {
          request.onDelta?.({
            kind: "usage",
            provider: "anthropic",
            model: "claude-sonnet-5",
            inputTokens: 100,
            outputTokens: 20,
          })
          return { kind: "tool", name: "reference.echo", input: { value: "x" } }
        }
        // Same pair sums; a non-finite or missing figure must not poison the sum.
        request.onDelta?.({
          kind: "usage",
          provider: "anthropic",
          model: "claude-sonnet-5",
          inputTokens: 140,
          outputTokens: Number.NaN,
        })
        request.onDelta?.({ kind: "usage", outputTokens: 9 })
        return { kind: "output", value: { answer: "done" } }
      },
    }
    mountAgUI(app, {
      agent: definition([echoTool]),
      ports: ports({ model, capabilities: ["reference.echo"] }),
      evidenceLog: createMemoryAgentEvidenceLog(),
    })

    const body = {
      threadId: "thread-1",
      runId: "run-1",
      forwardedProps: { input: { prompt: "x" } },
    }
    const list = await events(
      await call(
        new Request("http://local/agui", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
    )
    const finished = list.at(-1) as { type: string; usage?: unknown }
    expect(finished.type).toBe("RUN_FINISHED")
    expect(finished.usage).toEqual([
      { provider: "anthropic", model: "claude-sonnet-5", inputTokens: 240, outputTokens: 20 },
      { outputTokens: 9 },
    ])
    // Usage never becomes a frame of its own.
    expect(types(list)).not.toContain("USAGE")

    // The stored terminal events carry the usage, so a replayed stream reports the same totals.
    const replayed = await events(
      await call(
        new Request("http://local/agui", {
          method: "POST",
          headers: { "content-type": "application/json", "last-event-id": "0" },
          body: JSON.stringify(body),
        }),
      ),
    )
    const replayFinished = replayed.at(-1) as { type: string; usage?: unknown }
    expect(replayFinished.type).toBe("RUN_FINISHED")
    expect(replayFinished.usage).toEqual([
      { provider: "anthropic", model: "claude-sonnet-5", inputTokens: 240, outputTokens: 20 },
      { outputTokens: 9 },
    ])
  })

  test("omits usage when the port reports none", async () => {
    const { app, call } = captureApp()
    mountAgUI(app, { agent: definition(), ports: ports() })

    const list = await events(await call(runInput({ forwardedProps: { input: { prompt: "x" } } })))
    const finished = list.at(-1) as Record<string, unknown>
    expect(finished.type).toBe("RUN_FINISHED")
    expect("usage" in finished).toBe(false)
  })
})

describe("mountAgUI shared state", () => {
  test("announces body.state upfront and streams patches as STATE_DELTA", async () => {
    const { app, call } = captureApp()
    mountAgUI(app, {
      agent: definition(),
      ports: (_c, run) => ({
        capabilities: [],
        model: {
          complete: () => {
            run.sharedState.patch([{ op: "add", path: "/progress", value: 1 }])
            return { kind: "output", value: { answer: "hi" } }
          },
        },
      }),
    })

    const list = await events(
      await call(runInput({ state: { progress: 0 }, forwardedProps: { input: { prompt: "x" } } })),
    )
    const sequence = types(list)
    const snapshots = list.filter((e) => e.type === "STATE_SNAPSHOT") as { snapshot: unknown }[]
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.snapshot).toEqual({ progress: 0 })
    expect(sequence.indexOf("STATE_SNAPSHOT")).toBeGreaterThan(sequence.indexOf("CUSTOM"))
    const delta = list.find((e) => e.type === "STATE_DELTA") as { delta: unknown[] }
    expect(delta.delta).toEqual([{ op: "add", path: "/progress", value: 1 }])
  })

  test("announces a first patch on an unseeded document as a STATE_SNAPSHOT", async () => {
    const { app, call } = captureApp()
    mountAgUI(app, {
      agent: definition(),
      ports: (_c, run) => ({
        capabilities: [],
        model: {
          complete: () => {
            run.sharedState.patch([{ op: "add", path: "/step", value: "a" }])
            run.sharedState.patch([{ op: "replace", path: "/step", value: "b" }])
            return { kind: "output", value: { answer: "hi" } }
          },
        },
      }),
    })

    const list = await events(await call(runInput({ forwardedProps: { input: { prompt: "x" } } })))
    const snapshots = list.filter((e) => e.type === "STATE_SNAPSHOT") as { snapshot: unknown }[]
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.snapshot).toEqual({ step: "a" })
    const deltas = list.filter((e) => e.type === "STATE_DELTA") as { delta: unknown[] }[]
    expect(deltas).toHaveLength(1)
    expect(deltas[0]?.delta).toEqual([{ op: "replace", path: "/step", value: "b" }])
  })

  test("emits no state events when nothing touches the channel", async () => {
    const { app, call } = captureApp()
    mountAgUI(app, { agent: definition(), ports: ports() })

    const list = await events(await call(runInput({ forwardedProps: { input: { prompt: "x" } } })))
    expect(types(list)).not.toContain("STATE_SNAPSHOT")
    expect(types(list)).not.toContain("STATE_DELTA")
  })

  test("hands the ports factory the resolved turn id", async () => {
    const { app, call } = captureApp()
    let seenTurnId: string | undefined
    mountAgUI(app, {
      agent: definition(),
      ports: (_c, run) => {
        seenTurnId = run.turnId
        return { capabilities: [], model: outputModel({ answer: "hi" }) }
      },
    })

    await events(await call(runInput({ forwardedProps: { input: { prompt: "x" } } })))
    expect(seenTurnId).toBe("run-1")
  })
})
