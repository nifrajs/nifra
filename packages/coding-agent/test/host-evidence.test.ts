import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  AgentBackend,
  AgentEvent,
  AgentEventPayload,
  AgentSessionSnapshot,
  CreateSessionInput,
} from "@nifrajs/agent-protocol"
import { CodingAgentHost } from "../src/host.ts"
import { FileSessionStore, type SessionLogEntry, type SessionStore } from "../src/sessions.ts"

/** A backend that plays one scripted list of event payloads per `send`. */
class ScriptBackend implements AgentBackend {
  readonly info = { name: "script", capabilities: [] }
  readonly messages: string[] = []
  forked: unknown[] = []
  private current: AgentSessionSnapshot | undefined
  private sequence = 0

  constructor(private readonly turns: readonly (readonly AgentEventPayload[])[]) {}

  async createSession(input: CreateSessionInput): Promise<AgentSessionSnapshot> {
    const now = Date.now()
    this.current = {
      version: 1,
      id: input.sessionId ?? "script-session",
      backend: this.info.name,
      cwd: input.cwd,
      status: "idle",
      createdAt: now,
      updatedAt: now,
      lastSeq: 0,
      capabilities: [],
    }
    return this.current
  }

  send(input: { readonly message: string }): AsyncIterable<AgentEvent> {
    const sessionId = this.current?.id ?? "script-session"
    const payloads = this.turns[this.messages.length] ?? []
    this.messages.push(input.message)
    const events = payloads.map(
      (payload) =>
        ({ version: 1, sessionId, seq: this.sequence++, at: Date.now(), ...payload }) as AgentEvent,
    )
    return (async function* () {
      yield* events
    })()
  }

  async cancel(): Promise<void> {}
  async snapshot(): Promise<AgentSessionSnapshot> {
    if (this.current === undefined) throw new Error("script backend: no session")
    return this.current
  }
  async reload() {
    return { revision: "1", loaded: [], disabled: [], rolledBack: false }
  }
  async close(): Promise<void> {
    this.current = undefined
  }
}

const turnId = "turn-1"
const callId = "call-1"

async function withStore<T>(run: (store: FileSessionStore) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "nifra-host-evidence-"))
  try {
    return await run(new FileSessionStore({ root }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function drain(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

const evidence = (entries: readonly SessionLogEntry[], type: string) =>
  entries.filter((entry) => entry.type === type).map((entry) => entry.payload)

describe("coding agent host evidence", () => {
  test("keeps counts and ids for every event type, never the content", () =>
    withStore(async (store) => {
      const backend = new ScriptBackend([
        [
          { type: "turn.started", turnId, prompt: "plan it" },
          {
            type: "plan.updated",
            turnId,
            entries: [
              { content: "read", status: "completed" },
              { content: "write", status: "pending" },
            ],
          },
          { type: "context.usage", turnId, usedTokens: 10, windowTokens: 100 },
          { type: "tool.started", turnId, callId, name: "read_file", input: { path: "a.ts" } },
          { type: "tool.delta", turnId, callId, text: "secret partial output" },
          { type: "memory.compacted", before: 10, after: 5, reason: "manual" },
          {
            type: "extension.reloaded",
            revision: "2",
            loaded: ["lint"],
            disabled: [],
            rolledBack: false,
          },
          {
            type: "repair.required",
            turnId,
            task: {
              id: "repair-1",
              verification: "check",
              cwd: "/work",
              reason: "secret failure text",
              capabilities: ["read"],
            },
          },
          { type: "verification.completed", name: "check", ok: false },
          {
            type: "session.failed",
            error: { code: "MODEL_FAILED", message: "secret model error" },
            recoverable: true,
          },
        ],
        [{ type: "session.stopped", reason: "done" }],
      ])
      const host = new CodingAgentHost({ backend, sessionStore: store })
      const session = await host.start({ cwd: "/work", backend: "script" })
      const first = await drain(host.prompt("plan it"))
      expect(first.at(-1)?.type).toBe("session.failed")
      expect(host.snapshot?.status).toBe("failed")
      await drain(host.prompt("again"))
      expect(host.snapshot?.status).toBe("stopped")

      const entries = await store.read(session.id)
      expect(evidence(entries, "plan.updated")).toEqual([{ turnId, entries: 2, completed: 1 }])
      // The store redacts `*Tokens` keys by name, so only the shape is checked here.
      expect(
        evidence(entries, "context.usage").map((payload) => Object.keys(payload ?? {})),
      ).toEqual([["turnId", "usedTokens", "windowTokens"]])
      expect(evidence(entries, "tool.delta")).toEqual([{ turnId, callId }])
      expect(evidence(entries, "memory.compacted")).toEqual([
        { before: 10, after: 5, reason: "manual" },
      ])
      expect(evidence(entries, "extension.reloaded")).toEqual([
        { revision: "2", loaded: ["lint"], disabled: [], rolledBack: false },
      ])
      expect(evidence(entries, "repair.required")).toEqual([
        { turnId, taskId: "repair-1", verification: "check", capabilities: ["read"] },
      ])
      expect(evidence(entries, "verification.completed")).toEqual([{ name: "check", ok: false }])
      expect(evidence(entries, "session.failed")).toEqual([
        { errorCode: "MODEL_FAILED", recoverable: true },
      ])
      expect(JSON.stringify(entries)).not.toContain("secret")
      await expect(host.history(0)).rejects.toThrow("history limit must be between 1 and 4096")
      // The live context still sees the tool's text; only the persisted evidence drops it.
      expect(host.contextWindow.snapshot().map((record) => record.content)).toContain(
        "secret partial output",
      )
    }))

  test("a restored session continues after the highest persisted seq", async () => {
    const entries: SessionLogEntry[] = [
      {
        version: 1,
        sessionId: "restored",
        seq: 0,
        at: 1,
        type: "turn.started",
        payload: { seq: 4 },
      },
      { version: 1, sessionId: "restored", seq: 1, at: 2, type: "note", payload: 1n },
    ]
    const store: SessionStore = {
      append: async (sessionId, type, payload) => ({
        version: 1,
        sessionId,
        seq: 9,
        at: 3,
        type,
        payload,
      }),
      read: async () => entries,
      checkpoint: async () => {},
      fork: async () => "forked",
    }
    const host = new CodingAgentHost({
      backend: new ScriptBackend([[{ type: "turn.started", turnId, prompt: "next" }]]),
      sessionStore: store,
    })
    await host.start({ cwd: "/work", backend: "script", sessionId: "restored" })
    expect(host.contextWindow.snapshot().map((record) => record.content)).toContain(
      "[unserializable session evidence]",
    )
    const [event] = await drain(host.prompt("next"))
    expect(event?.seq).toBe(5)
  })
})

describe("coding agent host verification fallbacks", () => {
  async function verifyWith(script: string): Promise<{
    events: AgentEvent[]
    messages: readonly string[]
  }> {
    const root = await mkdtemp(join(tmpdir(), "nifra-host-verify-"))
    try {
      const verifier = join(root, "verify.ts")
      await writeFile(verifier, script)
      const backend = new ScriptBackend([[{ type: "turn.started", turnId, prompt: "go" }]])
      const host = new CodingAgentHost({
        backend,
        maxRepairAttempts: 1,
        verifyAfterTurn: ["check"],
        verification: { command: process.execPath, commandArgs: [verifier] },
      })
      await host.start({ cwd: root, backend: "script" })
      return { events: await drain(host.prompt("go")), messages: backend.messages }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  test("a report past the protocol bounds leaves the live events, the rest of the task stays", async () => {
    const deep = JSON.stringify({ a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } })
    const { events, messages } = await verifyWith(
      `console.log(${JSON.stringify(deep)}); process.exit(1)\n`,
    )
    const verified = events.find((event) => event.type === "verification.completed")
    expect(verified).toMatchObject({ name: "check", ok: false })
    expect(verified).not.toHaveProperty("report")
    const repair = events.find((event) => event.type === "repair.required")
    if (repair?.type !== "repair.required") throw new Error("no repair task was raised")
    expect(repair.task).not.toHaveProperty("report")
    expect(repair.task).toMatchObject({
      verification: "check",
      reason: "check failed with exit 1",
      capabilities: ["process", "read", "write"],
      output: `${deep}\n`,
    })
    expect(repair.task.id).toMatch(/^verification-check-/)
    expect(messages[1]).toContain(`Diagnostics (untrusted output):\n${deep}`)
  })

  test("a gate that fails silently asks for a repair with no diagnostics", async () => {
    const { messages } = await verifyWith("process.exit(1)\n")
    expect(messages).toHaveLength(2)
    expect(messages[1]).toContain("Diagnostics: unavailable")
  })
})

describe("coding agent host lifecycle", () => {
  test("an extension-event check that throws fails the event", async () => {
    expect(
      () =>
        new CodingAgentHost({
          backend: new ScriptBackend([]),
          extensionEvents: { "x-acme.note": "yes" as unknown as () => boolean },
        }),
    ).toThrow("the check for x-acme.note must be a function")
    const host = new CodingAgentHost({
      backend: new ScriptBackend([[{ type: "x-acme.note", turnId, data: { note: 1 } }]]),
      extensionEvents: {
        "x-acme.note": () => {
          throw new Error("check crashed")
        },
      },
    })
    await host.start({ cwd: "/work", backend: "script" })
    const [event] = await drain(host.prompt("go"))
    expect(event).toMatchObject({
      type: "session.failed",
      error: { code: "BACKEND_PROTOCOL" },
    })
    if (event?.type === "session.failed")
      expect(event.error.message).toContain("x-acme.note failed its registered check")
  })

  test("a stop while the start is persisting rolls the session back", async () => {
    const appending = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const store: SessionStore = {
      append: async (sessionId, type, payload) => {
        if (type === "session.started") {
          appending.resolve()
          await release.promise
        }
        return { version: 1, sessionId, seq: 0, at: 0, type, payload }
      },
      read: async () => [],
      checkpoint: async () => {},
      fork: async () => "forked",
    }
    const host = new CodingAgentHost({ backend: new ScriptBackend([]), sessionStore: store })
    const starting = host.start({ cwd: "/work", backend: "script" })
    await appending.promise
    const stopping = host.stop()
    release.resolve()
    await expect(starting).rejects.toThrow("the host stopped while the session was starting")
    await stopping
    expect(host.snapshot).toBeUndefined()
  })

  test("approvals and fork check the session and the store", async () => {
    const backend = new ScriptBackend([])
    const host = new CodingAgentHost({ backend })
    await expect(
      host.requestApproval({ id: "a1", action: "deploy", capability: "deploy" }),
    ).rejects.toThrow("start a session first")
    await host.start({ cwd: "/work", backend: "script" })
    const requested = host.requestApproval({ id: "a1", action: "deploy", capability: "deploy" })
    expect(host.pendingApprovals.map((approval) => approval.id)).toEqual(["a1"])
    await host.resolveApproval("a1", true)
    expect(await requested).toBe(true)
    await expect(host.fork()).rejects.toThrow("no session store is configured")
    const forking = Object.assign(backend, {
      fork: async (input: { sessionId: string; targetSessionId?: string }) => {
        backend.forked.push(input)
        return { sessionId: "child", parentSessionId: input.sessionId }
      },
    })
    expect(await host.fork("child")).toEqual({
      sessionId: "child",
      parentSessionId: "script-session",
    })
    expect(forking.forked).toEqual([{ sessionId: "script-session", targetSessionId: "child" }])
  })
})
