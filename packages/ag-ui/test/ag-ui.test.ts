import { describe, expect, test } from "bun:test"
import type { AgentDefinition, AgentModelPort, AgentPorts } from "@nifrajs/agent"
import { MemoryAgentStateStore } from "@nifrajs/agent"
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

  test("maps tool evidence to TOOL_CALL_START and TOOL_CALL_END", async () => {
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
    }
    expect(start.toolCallName).toBe("reference.echo")
    const end = list.find((e) => e.type === "TOOL_CALL_END") as { toolCallId: string }
    expect(end.toolCallId).toBe(start.toolCallId)
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
