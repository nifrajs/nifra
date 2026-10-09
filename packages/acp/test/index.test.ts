import { afterEach, describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import type { AgentEvent } from "@nifrajs/agent-protocol"
import { AcpBackend, type AcpBackendOptions } from "../src/index.ts"

const AGENT = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url))
const CWD = tmpdir()
const opened: Array<{ backend: AcpBackend; id: string }> = []

function backend(flags: readonly string[] = [], options: Partial<AcpBackendOptions> = {}) {
  return new AcpBackend({ command: process.execPath, args: [AGENT, ...flags], ...options })
}

async function session(
  flags: readonly string[] = [],
  options: Partial<AcpBackendOptions> = {},
): Promise<{ backend: AcpBackend; id: string }> {
  const created = backend(flags, options)
  const snapshot = await created.createSession({ cwd: CWD })
  const handle = { backend: created, id: snapshot.id }
  opened.push(handle)
  return handle
}

async function collect(source: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of source) events.push(event)
  return events
}

async function turn(message: string, flags: readonly string[] = [], options = {}) {
  const handle = await session(flags, options)
  return {
    ...handle,
    events: await collect(handle.backend.send({ sessionId: handle.id, message })),
  }
}

function texts(events: readonly AgentEvent[], type: "assistant.message" | "assistant.delta") {
  return events.flatMap((event) => (event.type === type ? [event.text] : []))
}

/** Reads a turn until a predicate holds, leaving the rest of the stream to read later. */
async function readUntil(
  iterator: AsyncIterator<AgentEvent>,
  until: (event: AgentEvent) => boolean,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
    events.push(next.value)
    if (until(next.value)) break
  }
  return events
}

afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.backend.close(handle.id)
})

describe("AcpBackend", () => {
  test("maps a turn's session updates into protocol events", async () => {
    const { backend: acp, id, events } = await turn("hello")
    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "assistant.delta",
      "assistant.delta",
      "reasoning.delta",
      "plan.updated",
      "context.usage",
      "context.usage",
      "x-acp.available_commands_update",
      "assistant.message",
      "session.completed",
    ])
    expect(texts(events, "assistant.message")).toEqual(["hello"])
    const plan = events.find((event) => event.type === "plan.updated")
    expect(plan?.type === "plan.updated" ? plan.entries : []).toEqual([
      { content: "Read", status: "completed", priority: "high" },
      { content: "Write", status: "in_progress" },
    ])
    const usage = events.flatMap((event) => (event.type === "context.usage" ? [event] : []))
    expect(usage.map((event) => [event.usedTokens, event.windowTokens])).toEqual([
      [1200, 200000],
      [1300, undefined],
    ])
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index))
    const snapshot = await acp.snapshot(id)
    expect(snapshot.status).toBe("idle")
    expect(snapshot.activeTurnId).toBeUndefined()
  })

  test("an allowed permission picks the one-time option and the tool completes", async () => {
    const { backend: acp, id } = await session()
    const iterator = acp.send({ sessionId: id, message: "approve" })[Symbol.asyncIterator]()
    const asked = await readUntil(iterator, (event) => event.type === "approval.required")
    expect(asked.map((event) => event.type)).toEqual([
      "turn.started",
      "assistant.delta",
      "assistant.message",
      "tool.started",
      "approval.required",
    ])
    const started = asked[3]
    expect(
      started?.type === "tool.started" ? [started.callId, started.name, started.input] : [],
    ).toEqual(["call_1", "edit", { path: "a.txt" }])
    const approval = asked[4]
    if (approval?.type !== "approval.required") throw new Error("no approval")
    expect([approval.action, approval.capability]).toEqual(["Write a.txt", "acp.edit"])
    expect(await acp.resolveApproval(id, approval.approvalId, true)).toBe(true)
    expect(await acp.resolveApproval(id, approval.approvalId, true)).toBeUndefined()
    const rest = await readUntil(iterator, () => false)
    const completed = rest.find((event) => event.type === "tool.completed")
    expect(completed?.type === "tool.completed" ? [completed.ok, completed.output] : []).toEqual([
      true,
      "written",
    ])
    expect(texts(rest, "assistant.message")).toEqual(["Done."])
    expect(rest.at(-1)?.type).toBe("session.completed")
  })

  test("a denied permission fails the tool call", async () => {
    const { backend: acp, id } = await session()
    const iterator = acp.send({ sessionId: id, message: "approve" })[Symbol.asyncIterator]()
    const approval = (await readUntil(iterator, (event) => event.type === "approval.required")).at(
      -1,
    )
    if (approval?.type !== "approval.required") throw new Error("no approval")
    expect(await acp.resolveApproval(id, approval.approvalId, false)).toBe(false)
    const rest = await readUntil(iterator, () => false)
    const completed = rest.find((event) => event.type === "tool.completed")
    expect(
      completed?.type === "tool.completed" ? [completed.ok, completed.error?.code] : [],
    ).toEqual([false, "ACP_TOOL_FAILED"])
  })

  test("an approval the agent withdraws resolves as denied and its request is answered", async () => {
    const { events } = await turn("withdraw")
    const resolved = events.find((event) => event.type === "approval.resolved")
    expect(
      resolved?.type === "approval.resolved" ? [resolved.approved, resolved.reason] : [],
    ).toEqual([false, "the agent withdrew the request"])
    expect(texts(events, "assistant.message")).toEqual(["withdrawn:-32800"])
  })

  test("client methods it does not offer and malformed params get JSON-RPC errors", async () => {
    const { events } = await turn("client-methods")
    expect(texts(events, "assistant.message")).toEqual(["-32601,-32602"])
  })

  test("the agent sees only the base environment and what env adds", async () => {
    const previous = process.env.NIFRA_ACP_LEAK
    process.env.NIFRA_ACP_LEAK = "leak"
    try {
      const { events } = await turn("env", [], { env: { VISIBLE: "yes", HOME: undefined } })
      expect(texts(events, "assistant.message")).toEqual(["yes|none|none"])
    } finally {
      if (previous === undefined) delete process.env.NIFRA_ACP_LEAK
      else process.env.NIFRA_ACP_LEAK = previous
    }
  })

  test.each([
    ["refuse", "session.failed", "ACP_REFUSAL"],
    ["no-stop", "session.failed", "ACP_PROTOCOL"],
    ["garbage", "session.failed", "ACP_PROTOCOL"],
    ["oversized", "session.failed", "ACP_PROTOCOL"],
  ])("a %s turn ends with %s %s", async (message, type, code) => {
    const { events } = await turn(message, [], { maxRecordBytes: 1024 })
    const last = events.at(-1)
    expect([last?.type, last?.type === "session.failed" ? last.error.code : undefined]).toEqual([
      type,
      code,
    ])
  })

  test("a stop reason other than end_turn completes the turn and says why", async () => {
    const { events } = await turn("max")
    const reason = events.find((event) => event.type === "x-acp.stop_reason")
    expect(reason?.type === "x-acp.stop_reason" ? reason.data : undefined).toEqual({
      stopReason: "max_tokens",
    })
    expect(texts(events, "assistant.message")).toEqual(["partial"])
    expect(events.at(-1)?.type).toBe("session.completed")
  })

  test("updates it cannot use are skipped, and the turn still completes", async () => {
    const { events } = await turn("bad-update")
    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "tool.started",
      "assistant.delta",
      "assistant.message",
      "session.completed",
    ])
    const started = events[1]
    expect(started?.type === "tool.started" ? started.name : undefined).toBe("tool")
  })

  test("a failed prompt keeps its reason and masks credentials", async () => {
    const { events } = await turn("fail", [], { env: { MY_TOKEN: "hunter2-secret" } })
    const failed = events.at(-1)
    if (failed?.type !== "session.failed") throw new Error("the turn did not fail")
    expect(failed.error.code).toBe("ACP_PROMPT_FAILED")
    expect(failed.error.message).toBe("model exploded with [REDACTED] and [REDACTED]")
  })

  test("an agent that exits fails the turn with its last error line, masked", async () => {
    const {
      backend: acp,
      id,
      events,
    } = await turn("crash", [], {
      env: { MY_TOKEN: "hunter2-secret" },
    })
    const failed = events.at(-1)
    if (failed?.type !== "session.failed") throw new Error("the turn did not fail")
    expect(failed.error.code).toBe("ACP_EXITED")
    expect(failed.error.message).toBe("the ACP agent exited with code 3: Error: boom [REDACTED]")
    expect(() => acp.send({ sessionId: id, message: "hello" })).toThrow("unknown session")
  })

  test("a cancel the agent honours stops the turn and the session goes on", async () => {
    const { backend: acp, id } = await session()
    const iterator = acp.send({ sessionId: id, message: "slow" })[Symbol.asyncIterator]()
    await readUntil(iterator, (event) => event.type === "turn.started")
    expect((await acp.snapshot(id)).status).toBe("running")
    await acp.cancel(id, "user stopped it")
    const rest = await readUntil(iterator, () => false)
    const stopped = rest.at(-1)
    expect(stopped?.type === "session.stopped" ? stopped.reason : undefined).toBe("user stopped it")
    const next = await collect(acp.send({ sessionId: id, message: "hello" }))
    expect(next.at(-1)?.type).toBe("session.completed")
  })

  test("an agent that ignores a cancel is stopped after the grace period", async () => {
    const { backend: acp, id } = await session([], { cancelGraceMs: 0 })
    const iterator = acp.send({ sessionId: id, message: "stubborn" })[Symbol.asyncIterator]()
    await readUntil(iterator, (event) => event.type === "turn.started")
    await acp.cancel(id)
    expect((await readUntil(iterator, () => false)).at(-1)?.type).toBe("session.stopped")
    expect(() => acp.send({ sessionId: id, message: "hello" })).toThrow("unknown session")
  })

  test("an abort signal cancels the turn, and an aborted one never starts", async () => {
    const { backend: acp, id } = await session()
    const controller = new AbortController()
    const iterator = acp
      .send({ sessionId: id, message: "slow", signal: controller.signal })
      [Symbol.asyncIterator]()
    await readUntil(iterator, (event) => event.type === "turn.started")
    controller.abort()
    expect((await readUntil(iterator, () => false)).at(-1)?.type).toBe("session.stopped")
    const aborted = await collect(
      acp.send({ sessionId: id, message: "hello", signal: AbortSignal.abort() }),
    )
    expect(aborted.map((event) => event.type)).toEqual(["turn.started", "session.stopped"])
  })

  test("closing a session stops its turn and answers its open approvals", async () => {
    const { backend: acp, id } = await session()
    const iterator = acp.send({ sessionId: id, message: "approve" })[Symbol.asyncIterator]()
    await readUntil(iterator, (event) => event.type === "approval.required")
    await acp.close(id)
    const stopped = (await readUntil(iterator, () => false)).at(-1)
    expect(stopped?.type === "session.stopped" ? stopped.reason : undefined).toBe("session closed")
    await acp.close(id)
    expect(await acp.resolveApproval(id, "anything", true)).toBeUndefined()
  })

  test("refuses a second turn, an unbounded message, and nothing it cannot reload", async () => {
    const { backend: acp, id } = await session()
    const iterator = acp.send({ sessionId: id, message: "slow" })[Symbol.asyncIterator]()
    await readUntil(iterator, (event) => event.type === "turn.started")
    await expect(collect(acp.send({ sessionId: id, message: "again" }))).rejects.toMatchObject({
      code: "SESSION_BUSY",
    })
    await acp.cancel(id)
    await expect(collect(acp.send({ sessionId: id, message: "" }))).rejects.toMatchObject({
      code: "MESSAGE_BOUNDED",
    })
    expect((await acp.reload()).error?.code).toBe("FEATURE_UNSUPPORTED")
  })

  test.each<[readonly string[], Partial<AcpBackendOptions>, string]>([
    [["--v2"], {}, "the agent speaks ACP version 2; this adapter speaks 1"],
    [["--need-auth"], {}, "the agent requires authentication; pass authMethod (one of: token)"],
    [["--no-session"], {}, "session/new answered without a sessionId"],
    [
      ["--die-on-init"],
      {},
      "the ACP agent exited with code 2: fatal: no credentials for [REDACTED]",
    ],
  ])("a handshake with %p fails", async (flags, options, message) => {
    await expect(backend(flags, options).createSession({ cwd: CWD })).rejects.toThrow(message)
  })

  test("authenticates with the method it is given", async () => {
    const { events } = await turn("hello", ["--need-auth"], { authMethod: "token" })
    expect(events.at(-1)?.type).toBe("session.completed")
  })

  test("validates its options and session input", async () => {
    expect(() => new AcpBackend({ command: "" })).toThrow("command is required")
    expect(() => backend([], { maxRecordBytes: 10 })).toThrow("maxRecordBytes must be between")
    expect(() => backend([], { cancelGraceMs: -1 })).toThrow("cancelGraceMs must be between")
    const acp = backend()
    await expect(acp.createSession({ cwd: "relative" })).rejects.toThrow("absolute path")
    await expect(acp.createSession({ cwd: CWD, sessionId: "bad id" })).rejects.toThrow(
      "bounded token",
    )
    await expect(acp.createSession({ cwd: CWD, capabilities: ["bad cap"] })).rejects.toThrow(
      "bounded tokens",
    )
    await expect(acp.snapshot("missing")).rejects.toThrow("unknown session")
    await acp.cancel("missing")
  })
})
