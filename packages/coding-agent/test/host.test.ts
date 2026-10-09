import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  AgentBackend,
  AgentBackendInfo,
  AgentEvent,
  AgentEventPayload,
  AgentSessionSnapshot,
  CreateSessionInput,
  ReloadResult,
  SendMessageInput,
} from "@nifrajs/agent-protocol"
import { CodingAgentHost } from "../src/host.ts"
import type { SessionStore } from "../src/sessions.ts"

class ScriptedBackend implements AgentBackend {
  readonly info: AgentBackendInfo = {
    name: "scripted",
    capabilities: [],
  }
  readonly messages: string[] = []
  cancelCalls = 0
  closeCalls = 0
  private current: AgentSessionSnapshot | undefined
  private sequence = 0

  constructor(private readonly stopOnly = false) {}

  async createSession(input: CreateSessionInput): Promise<AgentSessionSnapshot> {
    const now = Date.now()
    this.current = {
      version: 1,
      id: input.sessionId ?? "scripted-session",
      backend: this.info.name,
      cwd: input.cwd,
      status: "idle",
      createdAt: now,
      updatedAt: now,
      lastSeq: 0,
      capabilities: [],
    }
    this.sequence = 0
    return this.current
  }

  send(input: SendMessageInput): AsyncIterable<AgentEvent> {
    const session = this.requireSession()
    const turnId = `turn-${this.messages.length + 1}`
    this.messages.push(input.message)
    if (this.stopOnly) {
      const stopped = this.event({ type: "session.stopped", reason: "cancelled" })
      return (async function* (): AsyncGenerator<AgentEvent> {
        yield stopped
      })()
    }
    const events = [
      this.event({ type: "turn.started", turnId, prompt: input.message }),
      this.event({ type: "assistant.message", turnId, text: "turn complete" }),
      this.event({
        type: "session.completed",
        snapshot: {
          ...session,
          status: "idle",
          lastSeq: this.sequence,
          updatedAt: Date.now(),
        },
      }),
    ]
    return (async function* (): AsyncGenerator<AgentEvent> {
      for (const event of events) yield event
    })()
  }

  async cancel(): Promise<void> {
    this.cancelCalls++
  }

  async snapshot(): Promise<AgentSessionSnapshot> {
    return this.requireSession()
  }

  async reload(): Promise<ReloadResult> {
    return { revision: "1", loaded: [], disabled: [], rolledBack: false }
  }

  async close(): Promise<void> {
    this.closeCalls++
    this.current = undefined
  }

  private event(payload: AgentEventPayload): AgentEvent {
    const event = {
      version: 1 as const,
      sessionId: this.requireSession().id,
      seq: this.sequence++,
      at: Date.now(),
      ...payload,
    }
    return event as AgentEvent
  }

  private requireSession(): AgentSessionSnapshot {
    if (this.current === undefined) throw new Error("scripted backend: no session")
    return this.current
  }
}

test("host automatically repairs a failed verification and re-verifies", async () => {
  const root = await mkdtemp(join(tmpdir(), "nifra-agent-host-"))
  const marker = join(root, "verification.marker")
  const verifier = join(root, "verify.ts")
  await writeFile(
    verifier,
    [
      'import { existsSync, writeFileSync } from "node:fs"',
      "const marker = process.env.NIFRA_REPAIR_MARKER",
      "if (marker === undefined) process.exit(2)",
      "if (existsSync(marker)) { console.log(JSON.stringify({ ok: true })); process.exit(0) }",
      'writeFileSync(marker, "")',
      'console.log(JSON.stringify({ ok: false, error: "fixture failure" }))',
      "process.exit(1)",
      "",
    ].join("\n"),
  )

  const backend = new ScriptedBackend()
  const host = new CodingAgentHost({
    backend,
    maxRepairAttempts: 2,
    verifyAfterTurn: ["check"],
    verification: {
      command: process.execPath,
      commandArgs: [verifier],
      env: { NIFRA_REPAIR_MARKER: marker },
    },
  })
  try {
    await host.start({ cwd: root, backend: backend.info.name })
    const events: AgentEvent[] = []
    for await (const event of host.prompt("make the project healthy")) events.push(event)

    expect(backend.messages).toHaveLength(2)
    expect(backend.messages[1]).toContain("fixture failure")
    expect(events.filter((event) => event.type === "verification.completed")).toHaveLength(2)
    expect(events.filter((event) => event.type === "repair.required")).toHaveLength(1)
    expect(events.filter((event) => event.type === "verification.completed")[1]?.ok).toBe(true)
    expect(new Set(events.map((event) => event.seq)).size).toBe(events.length)
    expect(events.map((event) => event.seq)).toEqual(
      [...events].map((event) => event.seq).sort((left, right) => left - right),
    )
  } finally {
    await host.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test("host stops automatic repair at the configured attempt cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "nifra-agent-host-cap-"))
  const verifier = join(root, "verify.ts")
  await writeFile(
    verifier,
    [
      'console.log(JSON.stringify({ ok: false, error: "still broken" }))',
      "process.exit(1)",
      "",
    ].join("\n"),
  )

  const backend = new ScriptedBackend()
  const host = new CodingAgentHost({
    backend,
    maxRepairAttempts: 2,
    verifyAfterTurn: ["check"],
    verification: { command: process.execPath, commandArgs: [verifier] },
  })
  try {
    await host.start({ cwd: root, backend: backend.info.name })
    const events: AgentEvent[] = []
    for await (const event of host.prompt("make the project healthy")) events.push(event)

    expect(backend.messages).toHaveLength(3)
    expect(events.filter((event) => event.type === "verification.completed")).toHaveLength(3)
    expect(events.filter((event) => event.type === "repair.required")).toHaveLength(3)
  } finally {
    await host.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test("a gate that is not installed reports so once and starts no repair turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "nifra-agent-host-nogate-"))
  const backend = new ScriptedBackend()
  const host = new CodingAgentHost({
    backend,
    maxRepairAttempts: 2,
    verifyAfterTurn: ["check"],
    verification: { command: "nifra-gate-that-is-not-installed" },
  })
  try {
    await host.start({ cwd: root, backend: backend.info.name })
    const events: AgentEvent[] = []
    for await (const event of host.prompt("make the project healthy")) events.push(event)

    expect(backend.messages).toHaveLength(1)
    const verified = events.filter((event) => event.type === "verification.completed")
    expect(verified).toHaveLength(1)
    expect(verified[0]).toMatchObject({ ok: false, report: { unavailable: true } })
    expect(events.some((event) => event.type === "repair.required")).toBe(false)
  } finally {
    await host.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test("host converts malformed backend events into a bounded protocol failure", async () => {
  const backend = new ScriptedBackend()
  backend.send = () =>
    (async function* (): AsyncGenerator<AgentEvent> {
      yield { version: 1, sessionId: "wrong", seq: 0, at: 0, type: "assistant.delta" } as never
    })()
  const host = new CodingAgentHost({ backend })
  await host.start({ cwd: process.cwd(), sessionId: "malformed", backend: backend.info.name })
  const events: AgentEvent[] = []
  for await (const event of host.prompt("malformed")) events.push(event)
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ type: "session.failed", error: { code: "BACKEND_PROTOCOL" } })
  expect(host.snapshot?.status).toBe("failed")
  await host.stop()
})

test("a malformed backend event's failure names the field it broke", async () => {
  const backend = new ScriptedBackend()
  backend.send = () =>
    (async function* (): AsyncGenerator<AgentEvent> {
      yield {
        version: 1,
        sessionId: "named",
        seq: 0,
        at: 0,
        type: "turn.started",
        turnId: "t",
        prompt: "p".repeat(256 * 1024 + 1),
      } as never
    })()
  const host = new CodingAgentHost({ backend })
  await host.start({ cwd: process.cwd(), sessionId: "named", backend: backend.info.name })
  const events: AgentEvent[] = []
  for await (const event of host.prompt("long")) events.push(event)
  expect(events).toHaveLength(1)
  const failed = events[0] as Extract<AgentEvent, { type: "session.failed" }>
  expect(failed.error).toEqual({
    code: "BACKEND_PROTOCOL",
    message:
      "backend emitted an invalid agent event: turn.started.prompt is longer than 262144 characters",
  })
  await host.stop()
})

test("extension events pass through unless their registered check refuses them", async () => {
  const root = await mkdtemp(join(tmpdir(), "nifra-agent-host-ext-"))
  const appended: Array<{ type: string; payload: unknown }> = []
  const store = {
    append: async (_id: string, type: string, payload: unknown) => {
      appended.push({ type, payload })
    },
    checkpoint: async () => {},
    read: async () => [],
  } as unknown as SessionStore
  const run = async (extensionEvents?: Record<string, (event: never) => boolean>) => {
    const backend = new ScriptedBackend()
    const send = backend.send.bind(backend)
    backend.send = (input) =>
      (async function* (): AsyncGenerator<AgentEvent> {
        for await (const event of send(input)) {
          yield event
          if (event.type === "turn.started") {
            const base = { version: 1, sessionId: event.sessionId, at: 0 } as const
            yield {
              ...base,
              seq: 100,
              type: "x-codex.plan",
              turnId: event.turnId,
              data: { steps: 2 },
            }
            yield { ...base, seq: 101, type: "x-acme.notice", data: "unchecked" }
          }
        }
      })()
    const host = new CodingAgentHost({
      backend,
      sessionStore: store,
      ...(extensionEvents === undefined ? {} : { extensionEvents }),
    })
    await host.start({ cwd: root, backend: backend.info.name })
    const events: AgentEvent[] = []
    for await (const event of host.prompt("plan")) events.push(event)
    await host.stop()
    return events.map((event) => event.type)
  }
  try {
    expect(await run()).toEqual([
      "turn.started",
      "x-codex.plan",
      "x-acme.notice",
      "assistant.message",
      "session.completed",
    ])
    expect(appended.find((entry) => entry.type === "x-codex.plan")?.payload).toEqual({
      turnId: "turn-1",
    })
    expect(appended.find((entry) => entry.type === "x-acme.notice")?.payload).toEqual({})

    const checked: unknown[] = []
    expect(
      await run({
        "x-codex.plan": (event: { data?: unknown }) => {
          checked.push(event.data)
          return false
        },
      }),
    ).toEqual(["turn.started", "session.failed"])
    expect(checked).toEqual([{ steps: 2 }])

    expect(
      () =>
        new CodingAgentHost({
          backend: new ScriptedBackend(),
          extensionEvents: { plan: () => true },
        }),
    ).toThrow("extension event type must be x-<vendor>.<name>: plan")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("host snapshot becomes stopped when the backend emits only session.stopped", async () => {
  const backend = new ScriptedBackend(true)
  const host = new CodingAgentHost({ backend })
  await host.start({ cwd: process.cwd(), sessionId: "stop-only", backend: backend.info.name })
  const events: AgentEvent[] = []
  for await (const event of host.prompt("stop now")) events.push(event)
  expect(events.map((event) => event.type)).toEqual(["session.stopped"])
  expect(host.snapshot?.status).toBe("stopped")
  await host.stop()
})

test("host startup rolls back a backend session when persistence initialization fails", async () => {
  const backend = new ScriptedBackend()
  const store: SessionStore = {
    append: async () => {
      throw new Error("session store unavailable")
    },
    read: async () => [],
    checkpoint: async () => {},
    fork: async () => "unused",
  }
  const host = new CodingAgentHost({ backend, sessionStore: store })
  await expect(host.start({ cwd: process.cwd(), backend: backend.info.name })).rejects.toThrow(
    "session store unavailable",
  )
  expect(host.snapshot).toBeUndefined()
  expect(backend.cancelCalls).toBe(1)
  expect(backend.closeCalls).toBe(1)
})

test("host stop releases the backend when the stop audit write fails", async () => {
  const backend = new ScriptedBackend()
  let failAppend = false
  const store: SessionStore = {
    append: async () => {
      if (failAppend) throw new Error("session store became read-only")
      return {
        version: 1,
        sessionId: "scripted-session",
        seq: 0,
        at: Date.now(),
        type: "session.started",
      }
    },
    read: async () => [],
    checkpoint: async () => {},
    fork: async () => "unused",
  }
  const host = new CodingAgentHost({ backend, sessionStore: store })
  await host.start({ cwd: process.cwd(), backend: backend.info.name })
  failAppend = true
  await expect(host.stop()).rejects.toThrow("session store became read-only")
  expect(host.snapshot).toBeUndefined()
  expect(backend.cancelCalls).toBe(1)
  expect(backend.closeCalls).toBe(1)
})

test("a second start while one is in flight is refused, and stop closes the one that started", async () => {
  const backend = new ScriptedBackend()
  const host = new CodingAgentHost({ backend })
  const first = host.start({ cwd: process.cwd(), sessionId: "first" })
  await expect(host.start({ cwd: process.cwd(), sessionId: "second" })).rejects.toThrow(
    "already active",
  )
  expect((await first).id).toBe("first")
  await host.stop()
  expect(host.snapshot).toBeUndefined()
  expect(backend.closeCalls).toBe(1)
})

test("a stop during startup rolls the starting session back instead of leaving it live", async () => {
  const backend = new ScriptedBackend()
  const created = Promise.withResolvers<void>()
  const create = backend.createSession.bind(backend)
  backend.createSession = async (input) => {
    await created.promise
    return create(input)
  }
  const host = new CodingAgentHost({ backend })
  const starting = host.start({ cwd: process.cwd(), sessionId: "raced" })
  const stopping = host.stop()
  created.resolve()
  await expect(starting).rejects.toThrow("stopped while the session was starting")
  await stopping
  expect(host.snapshot).toBeUndefined()
  expect(backend.closeCalls).toBe(1)
})
