import { describe, expect, test } from "bun:test"
import type { AgentDefinition, AgentModelPort, AgentPorts } from "@nifrajs/agent"
import { MemoryAgentStateStore } from "@nifrajs/agent"
import { defineTool } from "@nifrajs/core/tool-contract"
import { t } from "@nifrajs/schema"
import {
  A2A_ERROR_CODES,
  A2A_PROTOCOL_VERSION,
  type A2AMountableApp,
  type A2ARouteContext,
  agentCard,
  mountA2A,
} from "../src/index.ts"

const input = t.object({ prompt: t.string() })
const output = t.object({ answer: t.string() })

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
  readonly app: A2AMountableApp
  callGet(req: Request): Promise<Response>
  callPost(req: Request): Promise<Response>
} {
  let getHandler: ((c: A2ARouteContext) => Response | Promise<Response>) | undefined
  let postHandler: ((c: A2ARouteContext) => Response | Promise<Response>) | undefined
  return {
    app: {
      get: (_path, h) => {
        getHandler = h
      },
      post: (_path, h) => {
        postHandler = h
      },
    },
    callGet: (req) => {
      if (getHandler === undefined) throw new Error("no GET handler mounted")
      return Promise.resolve(getHandler({ req }))
    },
    callPost: (req) => {
      if (postHandler === undefined) throw new Error("no POST handler mounted")
      return Promise.resolve(postHandler({ req }))
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

function rpc(method: string, params: unknown, id: string | number = 1): Request {
  return new Request("http://local/a2a", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  })
}

function message(parts: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { message: { messageId: "m1", role: "ROLE_USER", parts, ...extra } }
}

const cardInfo = { url: "https://example.test/a2a", version: "1.2.3" }

function ports(overrides: Partial<AgentPorts> = {}): (c: A2ARouteContext) => AgentPorts {
  return () => ({ model: outputModel({ answer: "hi" }), capabilities: [], ...overrides })
}

function frames(text: string): Record<string, unknown>[] {
  return text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice("data: ".length)) as Record<string, unknown>)
}

describe("agentCard", () => {
  test("derives a spec-shaped card from the definition", () => {
    const card = agentCard(definition([approvalTool]), cardInfo)
    expect(card.protocolVersion).toBe(A2A_PROTOCOL_VERSION)
    expect(card.name).toBe("reference-agent")
    expect(card.url).toBe(cardInfo.url)
    expect(card.capabilities.streaming).toBe(true)
    expect(card.skills).toEqual([
      {
        id: "reference.approve",
        name: "reference.approve",
        description: "Run an approved reference action.",
        tags: ["reference.approve"],
      },
    ])
  })
})

describe("mountA2A", () => {
  test("serves the agent card on GET", async () => {
    const { app, callGet } = captureApp()
    mountA2A(app, { agent: definition(), card: cardInfo, ports: ports() })

    const res = await callGet(new Request("http://local/.well-known/agent-card.json"))
    expect(res.status).toBe(200)
    const card = (await res.json()) as Record<string, unknown>
    expect(card.protocolVersion).toBe(A2A_PROTOCOL_VERSION)
    expect(card.version).toBe("1.2.3")
  })

  test("returns a safe server error when the agent card is not JSON-serializable", async () => {
    const { app, callGet } = captureApp()
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: deliberately inject an unsupported runtime value to exercise the serialization failure response.
    const invalidCard = { ...cardInfo, description: 1n } as unknown as typeof cardInfo
    mountA2A(app, { agent: definition(), card: invalidCard, ports: ports() })

    const response = await callGet(new Request("http://local/.well-known/agent-card.json"))
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: "response_serialization_failed" })
  })

  test("SendMessage completes a task with a JSON output artifact", async () => {
    const { app, callPost } = captureApp()
    mountA2A(app, { agent: definition(), card: cardInfo, ports: ports() })

    const res = await callPost(
      rpc(
        "SendMessage",
        message([{ text: JSON.stringify({}) }], {
          metadata: { input: { prompt: "hey" } },
        }),
      ),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result: { task: { status: { state: string }; artifacts: { parts: { text: string }[] }[] } }
    }
    const task = body.result.task
    expect(task.status.state).toBe("TASK_STATE_COMPLETED")
    expect(JSON.parse(task.artifacts[0]?.parts[0]?.text ?? "")).toEqual({ answer: "hi" })
  })

  test("falls back to the first text part as input", async () => {
    const { app, callPost } = captureApp()
    const seen: unknown[] = []
    const model: AgentModelPort = {
      complete: (request) => {
        seen.push(request.input)
        return { kind: "output", value: { answer: "ok" } }
      },
    }
    const stringInput = { ...definition(), input: t.string() }
    mountA2A(app, { agent: stringInput, card: cardInfo, ports: ports({ model }) })

    await callPost(rpc("SendMessage", message([{ text: "plain question" }])))
    expect(seen).toEqual(["plain question"])
  })

  test("rejects unknown methods and unsupported spec methods at the JSON-RPC layer", async () => {
    const { app, callPost } = captureApp()
    mountA2A(app, { agent: definition(), card: cardInfo, ports: ports() })

    const unknown = (await (await callPost(rpc("Nope", {}))).json()) as {
      error: { code: number }
    }
    expect(unknown.error.code).toBe(A2A_ERROR_CODES.methodNotFound)

    const unsupported = (await (await callPost(rpc("CancelTask", { id: "t1" }))).json()) as {
      error: { code: number }
    }
    expect(unsupported.error.code).toBe(A2A_ERROR_CODES.unsupportedOperation)
  })

  test("rejects a body that is not a JSON-RPC request", async () => {
    const { app, callPost } = captureApp()
    mountA2A(app, { agent: definition(), card: cardInfo, ports: ports() })

    const res = await callPost(
      new Request("http://local/a2a", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      }),
    )
    const body = (await res.json()) as { error: { code: number } }
    expect(body.error.code).toBe(A2A_ERROR_CODES.invalidRequest)
  })

  test("SendStreamingMessage streams status updates and ends with a final terminal frame", async () => {
    const { app, callPost } = captureApp()
    mountA2A(app, { agent: definition(), card: cardInfo, ports: ports() })

    const res = await callPost(
      rpc(
        "SendStreamingMessage",
        message([], {
          metadata: { input: { prompt: "hey" } },
        }),
      ),
    )
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const events = frames(await res.text())
    const results = events.map((e) => e.result as Record<string, unknown> | undefined)
    expect(results.some((r) => r?.statusUpdate !== undefined)).toBe(true)
    expect(results.some((r) => r?.artifactUpdate !== undefined)).toBe(true)
    const last = results.at(-1)?.statusUpdate as {
      final: boolean
      status: { state: string }
    }
    expect(last.final).toBe(true)
    expect(last.status.state).toBe("TASK_STATE_COMPLETED")
  })

  test("a client that cancels the stream aborts the run's signal", async () => {
    const { app, callPost } = captureApp()
    const called = Promise.withResolvers<AbortSignal>()
    const model: AgentModelPort = {
      complete: (request) => {
        called.resolve(request.signal)
        return new Promise((_resolve, reject) =>
          request.signal.addEventListener("abort", () => reject(new Error("aborted"))),
        )
      },
    }
    mountA2A(app, { agent: definition(), card: cardInfo, ports: ports({ model }) })
    const res = await callPost(
      rpc("SendStreamingMessage", message([], { metadata: { input: { prompt: "hey" } } })),
    )
    const signal = await called.promise
    expect(signal.aborted).toBe(false)
    await res.body?.cancel()
    expect(signal.aborted).toBe(true)
  })

  test("a signal the caller passes through ports still reaches the streamed run", async () => {
    const { app, callPost } = captureApp()
    const caller = new AbortController()
    const called = Promise.withResolvers<AbortSignal>()
    const model: AgentModelPort = {
      complete: (request) => {
        called.resolve(request.signal)
        return new Promise((_resolve, reject) =>
          request.signal.addEventListener("abort", () => reject(new Error("aborted"))),
        )
      },
    }
    mountA2A(app, {
      agent: definition(),
      card: cardInfo,
      ports: ports({ model, signal: caller.signal }),
    })
    const res = await callPost(
      rpc("SendStreamingMessage", message([], { metadata: { input: { prompt: "hey" } } })),
    )
    const signal = await called.promise
    caller.abort()
    expect(signal.aborted).toBe(true)
    expect(frames(await res.text()).at(-1)?.result).toEqual({
      statusUpdate: expect.objectContaining({
        final: true,
        status: expect.objectContaining({ state: "TASK_STATE_CANCELED" }),
      }),
    })
  })

  /** Suspend `reference.approve` on a pending approval, then resume it with the peer granting it. */
  async function resumeWithPeerApproval(
    overrides: Partial<AgentPorts>,
    portDecision: () => "pending" | "approved",
    approvalPort = true,
  ): Promise<{ state: string; executed: number; callerDecisions: unknown[] }> {
    const { app, callPost } = captureApp()
    let executed = 0
    const tool = defineTool({
      ...approvalTool,
      execute: () => {
        executed += 1
        return { ok: true }
      },
    })
    const callerDecisions: unknown[] = []
    const approval: NonNullable<AgentPorts["approval"]> = {
      request: ({ effectId, callerDecision }) => {
        if (callerDecision !== undefined) callerDecisions.push(callerDecision)
        return callerDecision === undefined || portDecision() === "pending"
          ? { status: "pending", effectId }
          : { status: "approved", approval: { granted: true } }
      },
    }
    const agentPorts: Partial<AgentPorts> = {
      model: toolThenOutputModel("reference.approve", { value: "x" }, { answer: "approved" }),
      capabilities: ["reference.approve"],
      state: new MemoryAgentStateStore(),
      ...overrides,
    }
    mountA2A(app, {
      agent: definition([tool]),
      card: cardInfo,
      ports: ports(approvalPort ? { approval, ...agentPorts } : agentPorts),
    })

    const first = (await (
      await callPost(rpc("SendMessage", message([], { metadata: { input: { prompt: "go" } } })))
    ).json()) as {
      result: {
        task: {
          id: string
          status: { state: string; message: { metadata: { continuation: { effectId: string } } } }
        }
      }
    }
    const task = first.result.task
    expect(task.status.state).toBe("TASK_STATE_INPUT_REQUIRED")
    const continuation = task.status.message.metadata.continuation

    const resumed = (await (
      await callPost(
        rpc(
          "SendMessage",
          message([], {
            taskId: task.id,
            metadata: {
              input: { prompt: "go" },
              resume: {
                continuation: { ...continuation, input: { value: "x" } },
                approval: { granted: true },
              },
            },
          }),
          2,
        ),
      )
    ).json()) as { result: { task: { status: { state: string } } } }
    return { state: resumed.result.task.status.state, executed, callerDecisions }
  }

  test("a resuming peer cannot approve its own tool call: the approval port decides", async () => {
    const refused = await resumeWithPeerApproval({}, () => "pending")
    expect(refused).toEqual({
      state: "TASK_STATE_INPUT_REQUIRED",
      executed: 0,
      callerDecisions: [{ granted: true }],
    })

    const approved = await resumeWithPeerApproval({}, () => "approved")
    expect(approved.state).toBe("TASK_STATE_COMPLETED")
    expect(approved.executed).toBe(1)
  })

  test("a peer's approval stands alone without an approval port only under the caller opt-out", async () => {
    const noPort = await resumeWithPeerApproval({}, () => "pending", false)
    expect(noPort.state).toBe("TASK_STATE_INPUT_REQUIRED")
    expect(noPort.executed).toBe(0)

    const optedOut = await resumeWithPeerApproval({ resumeApproval: "caller" }, () => "pending")
    expect(optedOut).toEqual({ state: "TASK_STATE_COMPLETED", executed: 1, callerDecisions: [] })
  })

  test("a task suspended on a model failure resumes with its echoed continuation", async () => {
    const { app, callPost } = captureApp()
    let calls = 0
    mountA2A(app, {
      agent: definition(),
      card: cardInfo,
      ports: ports({
        model: {
          complete: () => {
            calls += 1
            if (calls === 1) throw new Error("provider unavailable")
            return { kind: "output", value: { answer: "recovered" } }
          },
        },
        state: new MemoryAgentStateStore(),
      }),
    })
    const first: {
      result: {
        task: { id: string; status: { message: { metadata: { continuation: unknown } } } }
      }
    } = await (
      await callPost(rpc("SendMessage", message([], { metadata: { input: { prompt: "go" } } })))
    ).json()
    const task = first.result.task
    const resumed: { result: { task: { status: { state: string } } } } = await (
      await callPost(
        rpc(
          "SendMessage",
          message([], {
            taskId: task.id,
            metadata: {
              input: { prompt: "go" },
              resume: { continuation: task.status.message.metadata.continuation },
            },
          }),
          2,
        ),
      )
    ).json()
    expect(resumed.result.task.status.state).toBe("TASK_STATE_COMPLETED")
    expect(calls).toBe(2)
  })

  test("a task id without resume metadata is rejected", async () => {
    const { app, callPost } = captureApp()
    mountA2A(app, { agent: definition(), card: cardInfo, ports: ports() })

    const body = (await (
      await callPost(rpc("SendMessage", message([], { taskId: "task-1" })))
    ).json()) as { error: { code: number; message: string } }
    expect(body.error.code).toBe(A2A_ERROR_CODES.invalidParams)
    expect(body.error.message).toBe("resume_metadata_required")
  })

  test("GetTask projects stored state and reports missing tasks", async () => {
    const { app, callPost } = captureApp()
    const store = new MemoryAgentStateStore()
    mountA2A(app, { agent: definition(), card: cardInfo, ports: ports({ state: store }) })

    await callPost(rpc("SendMessage", message([], { metadata: { input: { prompt: "hey" } } })))
    const missing = (await (await callPost(rpc("GetTask", { id: "nope" }))).json()) as {
      error: { code: number }
    }
    expect(missing.error.code).toBe(A2A_ERROR_CODES.taskNotFound)
  })

  test("GetTask rejects malformed or traversal-like task ids before touching the store", async () => {
    const { app, callPost } = captureApp()
    const requested: string[] = []
    const store = new MemoryAgentStateStore()
    const guardedStore = {
      load: async (id: string) => {
        requested.push(id)
        return store.load(id)
      },
      save: store.save.bind(store),
    }
    mountA2A(app, { agent: definition(), card: cardInfo, ports: ports({ state: guardedStore }) })

    for (const id of ["../../etc/passwd", "", "x".repeat(129)]) {
      const body = (await (await callPost(rpc("GetTask", { id }))).json()) as {
        error: { code: number; message: string }
      }
      expect(body.error.code).toBe(A2A_ERROR_CODES.invalidParams)
      expect(body.error.message).toBe("invalid_task_id")
    }
    expect(requested).toEqual([])
  })

  test("bounds oversized JSON-RPC responses", async () => {
    const { app, callPost } = captureApp()
    mountA2A(app, {
      agent: definition(),
      card: cardInfo,
      maxOutputBytes: 1024,
      ports: ports({ model: outputModel({ answer: "x".repeat(4_000) }) }),
    })

    const response = await callPost(
      rpc("SendMessage", message([], { metadata: { input: { prompt: "x" } } }), "big"),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: "big",
      error: { code: A2A_ERROR_CODES.internalError, message: "output_limit" },
    })
  })

  test("a stream that hits maxOutputBytes stops its run instead of leaving it to spend model calls", async () => {
    const step = defineTool({
      name: "step",
      description: "One step.",
      input: t.object({ v: t.string() }),
      output: t.object({ ok: t.boolean() }),
      capability: "step",
      execute: () => ({ ok: true }),
    })
    const signals: AbortSignal[] = []
    const { app, callPost } = captureApp()
    mountA2A(app, {
      agent: definition([step]),
      card: cardInfo,
      maxOutputBytes: 2048,
      maxTurns: 200,
      ports: ports({
        capabilities: ["step"],
        model: {
          complete: (request) => {
            signals.push(request.signal)
            return signals.length < 60
              ? { kind: "tool", name: "step", input: { v: "x".repeat(50) } }
              : { kind: "output", value: { answer: "done" } }
          },
        },
      }),
    })
    const response = await callPost(
      rpc("SendStreamingMessage", message([], { metadata: { input: { prompt: "p" } } }), "s"),
    )
    const sent = frames(await response.text())
    expect(sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: "s",
      error: { code: A2A_ERROR_CODES.internalError, message: "output_limit" },
    })
    // The stream closed on the limit, and the run it carried was told to stop at that moment.
    expect(signals.at(-1)?.aborted).toBe(true)
  })

  test("a request the mount cannot complete gets a JSON-RPC error carrying its id", async () => {
    const failingPorts = captureApp()
    mountA2A(failingPorts.app, {
      agent: definition(),
      card: cardInfo,
      ports: () => {
        throw new Error("ports unavailable")
      },
    })
    expect(
      await (
        await failingPorts.callPost(
          rpc("SendMessage", message([], { metadata: { input: { prompt: "x" } } }), 41),
        )
      ).json(),
    ).toEqual({
      jsonrpc: "2.0",
      id: 41,
      error: { code: A2A_ERROR_CODES.internalError, message: "internal_error" },
    })

    const failingStore = captureApp()
    mountA2A(failingStore.app, {
      agent: definition(),
      card: cardInfo,
      ports: ports({
        state: {
          load: () => {
            throw new Error("store offline")
          },
          save: () => {},
        },
      }),
    })
    expect(
      await (await failingStore.callPost(rpc("GetTask", { id: "task-1" }, "lookup"))).json(),
    ).toEqual({
      jsonrpc: "2.0",
      id: "lookup",
      error: { code: A2A_ERROR_CODES.internalError, message: "internal_error" },
    })
  })

  test("a configured output limit above the default lets a larger result through", async () => {
    const { app, callPost } = captureApp()
    const answer = "x".repeat(5 * 1024 * 1024)
    mountA2A(app, {
      agent: definition(),
      card: cardInfo,
      maxOutputBytes: 8 * 1024 * 1024,
      ports: ports({ model: outputModel({ answer }) }),
    })

    const response = await callPost(
      rpc("SendMessage", message([], { metadata: { input: { prompt: "x" } } })),
    )
    expect(response.status).toBe(200)
    expect(JSON.stringify(await response.json())).toContain(answer)
  })
})

describe("mountA2A request checks", () => {
  const post = (body: string) =>
    new Request("http://local/a2a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })

  test("a method that is not a string is an invalid request", async () => {
    const { app, callPost } = captureApp()
    mountA2A(app, { agent: definition(), card: cardInfo, ports: ports() })
    const response = await callPost(post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: 5 })))
    expect(await response.json()).toMatchObject({
      error: { code: A2A_ERROR_CODES.invalidRequest, message: "invalid_request" },
    })
  })

  test("SendMessage refuses a missing message, a bad task id, and a resume without a task", async () => {
    const { app, callPost } = captureApp()
    mountA2A(app, { agent: definition(), card: cardInfo, ports: ports() })
    const resume = { continuation: { kind: "approval", effectId: "effect-1" } }
    const cases: [unknown, string][] = [
      [{}, "invalid_params"],
      [message([], { taskId: "../escape" }), "invalid_task_id"],
      [message([], { metadata: { resume } }), "task_id_required"],
    ]
    for (const [params, expected] of cases) {
      expect(await (await callPost(rpc("SendMessage", params))).json()).toMatchObject({
        error: { code: A2A_ERROR_CODES.invalidParams, message: expected },
      })
    }
    const unknown = await callPost(
      rpc("SendMessage", message([], { taskId: "task-unknown", metadata: { resume } })),
    )
    expect(await unknown.json()).toMatchObject({
      error: { code: A2A_ERROR_CODES.taskNotFound, message: "task_not_resumable" },
    })
  })

  test("GetTask without an id is invalid params", async () => {
    const { app, callPost } = captureApp()
    mountA2A(app, { agent: definition(), card: cardInfo, ports: ports() })
    expect(await (await callPost(rpc("GetTask", {}))).json()).toMatchObject({
      error: { code: A2A_ERROR_CODES.invalidParams, message: "invalid_params" },
    })
  })

  test("bad JSON and a body that fails to read are parse errors, and an oversized body is a 413", async () => {
    const { app, callPost } = captureApp()
    mountA2A(app, { agent: definition(), card: cardInfo, maxBodyBytes: 64, ports: ports() })
    const parseError = {
      jsonrpc: "2.0",
      id: null,
      error: { code: A2A_ERROR_CODES.parseError, message: "parse_error" },
    }
    for (const body of ["not json", '{"__proto__":{"admin":true}}']) {
      const response = await callPost(post(body))
      expect([response.status, await response.json()]).toEqual([200, parseError])
    }
    expect((await callPost(post(JSON.stringify({ pad: "x".repeat(256) })))).status).toBe(413)
    const init: RequestInit & { readonly duplex: "half" } = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        pull(controller) {
          controller.error(new Error("connection reset"))
        },
      }),
      duplex: "half",
    }
    const parse = await callPost(new Request("http://local/a2a", init))
    expect(await parse.json()).toMatchObject({
      error: { code: A2A_ERROR_CODES.parseError, message: "parse_error" },
    })
  })

  test("maxOutputBytes is range-checked when the mount is made", () => {
    const { app } = captureApp()
    expect(() =>
      mountA2A(app, { agent: definition(), card: cardInfo, maxOutputBytes: 10, ports: ports() }),
    ).toThrow("A2A maxOutputBytes must be between 1024")
  })

  test("GetTask projects a stored completed task and a suspended one", async () => {
    type Task = { result: { task: { id: string; status: { state: string }; metadata: object } } }
    const taskOf = async (response: Response) => {
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the mount answers SendMessage and GetTask in this envelope; a missing task fails the read and the id check.
      const task = ((await response.json()) as Task).result.task
      expect(typeof task.id).toBe("string")
      return task
    }
    const store = new MemoryAgentStateStore()
    const completed = captureApp()
    mountA2A(completed.app, { agent: definition(), card: cardInfo, ports: ports({ state: store }) })
    const sent = await taskOf(
      await completed.callPost(
        rpc("SendMessage", message([], { metadata: { input: { prompt: "hey" } } })),
      ),
    )
    const done = await taskOf(await completed.callPost(rpc("GetTask", { id: sent.id })))
    expect(done).toMatchObject({
      id: sent.id,
      status: { state: "TASK_STATE_COMPLETED" },
    })

    const suspended = captureApp()
    mountA2A(suspended.app, {
      agent: definition([approvalTool]),
      card: cardInfo,
      ports: ports({
        state: store,
        model: toolThenOutputModel("reference.approve", { value: "x" }, { answer: "y" }),
        capabilities: ["reference.approve"],
      }),
    })
    const waiting = await taskOf(
      await suspended.callPost(
        rpc("SendMessage", message([], { metadata: { input: { prompt: "go" } } })),
      ),
    )
    const stored = await taskOf(await suspended.callPost(rpc("GetTask", { id: waiting.id })))
    expect(stored.status.state).toBe("TASK_STATE_INPUT_REQUIRED")
    expect(stored.metadata).toHaveProperty("continuation")
  })
})
