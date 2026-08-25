import { expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
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

class ScriptedBackend implements AgentBackend {
  readonly info: AgentBackendInfo = {
    name: "scripted",
    capabilities: [],
  }
  readonly messages: string[] = []
  private current: AgentSessionSnapshot | undefined
  private sequence = 0

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

  async cancel(): Promise<void> {}

  async snapshot(): Promise<AgentSessionSnapshot> {
    return this.requireSession()
  }

  async reload(): Promise<ReloadResult> {
    return { revision: "1", loaded: [], disabled: [], rolledBack: false }
  }

  async close(): Promise<void> {
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
  const command = join(root, "verify.sh")
  await writeFile(
    command,
    [
      "#!/bin/sh",
      'if [ -f "$NIFRA_REPAIR_MARKER" ]; then',
      "  printf '%s\\n' '{\"ok\":true}'",
      "  exit 0",
      "fi",
      'touch "$NIFRA_REPAIR_MARKER"',
      'printf \'%s\\n\' \'{"ok":false,"error":"fixture failure"}\'',
      "exit 1",
      "",
    ].join("\n"),
  )
  await chmod(command, 0o755)

  const backend = new ScriptedBackend()
  const host = new CodingAgentHost({
    backend,
    maxRepairAttempts: 2,
    verifyAfterTurn: ["check"],
    verification: { command, env: { NIFRA_REPAIR_MARKER: marker } },
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
  const command = join(root, "verify.sh")
  await writeFile(
    command,
    ["#!/bin/sh", 'printf \'%s\\n\' \'{"ok":false,"error":"still broken"}\'', "exit 1", ""].join(
      "\n",
    ),
  )
  await chmod(command, 0o755)

  const backend = new ScriptedBackend()
  const host = new CodingAgentHost({
    backend,
    maxRepairAttempts: 2,
    verifyAfterTurn: ["check"],
    verification: { command },
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
