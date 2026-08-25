import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  AgentApprovalRequiredEvent,
  AgentApprovalResolvedEvent,
  AgentEvent,
} from "@nifrajs/agent-protocol"
import { CodingAgentHost } from "../src/host.ts"
import { type NativeApprovalPort, NifraBackend } from "../src/native.ts"
import { ReplayBackend } from "../src/replay.ts"
import { FileSessionStore } from "../src/sessions.ts"

function isApprovalRequired(event: AgentEvent): event is AgentApprovalRequiredEvent {
  return event.type === "approval.required"
}

function isApprovalResolved(event: AgentEvent): event is AgentApprovalResolvedEvent {
  return event.type === "approval.resolved"
}

async function readUntil<T extends AgentEvent>(
  iterator: AsyncIterator<AgentEvent>,
  events: AgentEvent[],
  predicate: (event: AgentEvent) => event is T,
): Promise<T> {
  for (;;) {
    const next = await iterator.next()
    if (next.done) throw new Error("event stream ended before the expected event")
    events.push(next.value)
    if (predicate(next.value)) return next.value
  }
}

async function drain(iterator: AsyncIterator<AgentEvent>, events: AgentEvent[]): Promise<void> {
  for (;;) {
    const next = await iterator.next()
    if (next.done) return
    events.push(next.value)
  }
}

function makeNativeBackend(options: {
  readonly approval?: NativeApprovalPort
  readonly approvalTimeoutMs?: number
  readonly execute?: (input: unknown, context: { readonly signal: AbortSignal }) => unknown
}) {
  const executed: unknown[] = []
  const backend = new NifraBackend({
    model: {
      complete: ({ messages }) =>
        messages.some((message) => message.role === "tool")
          ? { type: "text", text: "done" }
          : { type: "tool", name: "write_file", input: { path: "safe.txt" } },
    },
    tools: [
      {
        name: "write_file",
        description: "Write a file in the authorized workspace",
        capabilities: ["filesystem.write"],
        requiresApproval: true,
        execute: (input, context) => {
          executed.push(input)
          return options.execute?.(input, { signal: context.signal }) ?? "written"
        },
      },
    ],
    ...(options.approval === undefined ? {} : { approval: options.approval }),
    ...(options.approvalTimeoutMs === undefined
      ? {}
      : { approvalTimeoutMs: options.approvalTimeoutMs }),
  })
  return { backend, executed }
}

async function startApprovalTurn(backend: NifraBackend) {
  await backend.createSession({ cwd: "/workspace", sessionId: "native" })
  const stream = backend.send({ sessionId: "native", message: "write the file" })
  const iterator = stream[Symbol.asyncIterator]()
  const events: AgentEvent[] = []
  const required = await readUntil(iterator, events, isApprovalRequired)
  return { events, iterator, required }
}

describe("NifraBackend native approvals", () => {
  test("emits ordered bounded approval events and resolves through AgentBackend", async () => {
    const { backend, executed } = makeNativeBackend({})
    const { events, iterator, required } = await startApprovalTurn(backend)

    expect(required.approvalId).toMatch(/^nifra-approval-[A-Za-z0-9-]{36}$/)
    expect(required.approvalId.length).toBeLessThanOrEqual(128)
    expect(required.action).toBe("write_file")
    expect(required.capability).toBe("filesystem.write")
    expect(await backend.resolveApproval("native", "stale-approval", true)).toBeUndefined()
    expect(await backend.resolveApproval("native", required.approvalId, true, "approved")).toBe(
      true,
    )
    await drain(iterator, events)

    const resolved = events.find(isApprovalResolved)
    const completed = events.find((event) => event.type === "tool.completed")
    expect(resolved?.approved).toBe(true)
    expect(completed?.ok).toBe(true)
    expect(executed).toEqual([{ path: "safe.txt" }])
    expect(events.findIndex(isApprovalRequired)).toBeLessThan(events.findIndex(isApprovalResolved))
    expect(events.findIndex(isApprovalResolved)).toBeLessThan(
      events.findIndex((event) => event.type === "tool.completed"),
    )
    expect(events.map((event) => event.seq)).toEqual(
      events.map((event) => event.seq).sort((left, right) => left - right),
    )
    expect(new Set(events.map((event) => event.seq)).size).toBe(events.length)
    await backend.close("native")
  })

  test("keeps the existing boolean approval callback compatible", async () => {
    const callbackInputs: Array<{ approvalId: string; action: string; capability: string }> = []
    const approval: NativeApprovalPort = {
      request: (input) => {
        callbackInputs.push({
          approvalId: input.approvalId,
          action: input.action,
          capability: input.capability,
        })
        return true
      },
    }
    const { backend, executed } = makeNativeBackend({ approval })
    const { events, iterator, required } = await startApprovalTurn(backend)
    await drain(iterator, events)

    expect(callbackInputs).toEqual([
      {
        approvalId: required.approvalId,
        action: "write_file",
        capability: "filesystem.write",
      },
    ])
    expect(events.some((event) => isApprovalResolved(event) && event.approved)).toBe(true)
    expect(executed).toHaveLength(1)
    await backend.close("native")
  })

  test("replays approval events without requiring a protocol version change", async () => {
    const replay = new ReplayBackend({
      events: [
        {
          version: 1,
          sessionId: "recorded",
          seq: 10,
          at: 1,
          type: "approval.required",
          turnId: "turn",
          approvalId: "nifra-approval-recorded",
          action: "write_file",
          capability: "filesystem.write",
        },
        {
          version: 1,
          sessionId: "recorded",
          seq: 11,
          at: 2,
          type: "approval.resolved",
          turnId: "turn",
          approvalId: "nifra-approval-recorded",
          approved: true,
        },
      ],
    })
    await replay.createSession({ cwd: "/workspace", sessionId: "replay" })
    const events: AgentEvent[] = []
    for await (const event of replay.send({ sessionId: "replay", message: "replay" }))
      events.push(event)

    expect(
      events.filter((event) => event.type.startsWith("approval.")).map((event) => event.type),
    ).toEqual(["approval.required", "approval.resolved"])
    expect(events.map((event) => event.seq)).toEqual(
      events.map((event) => event.seq).sort((left, right) => left - right),
    )
    await replay.close("replay")
  })

  test("reports a bounded distinct denial error without executing the tool", async () => {
    const { backend, executed } = makeNativeBackend({})
    const { events, iterator, required } = await startApprovalTurn(backend)
    expect(
      await backend.resolveApproval("native", required.approvalId, false, "x".repeat(10_000)),
    ).toBe(false)
    await drain(iterator, events)

    const completed = events.find((event) => event.type === "tool.completed")
    expect(completed?.ok).toBe(false)
    expect(completed?.error?.code).toBe("APPROVAL_DENIED")
    expect(completed?.error?.message.length).toBeLessThanOrEqual(512)
    expect(executed).toHaveLength(0)
    await backend.close("native")
  })

  test("fails a pending approval closed on cancellation", async () => {
    const { backend, executed } = makeNativeBackend({})
    const { events, iterator, required } = await startApprovalTurn(backend)
    await backend.cancel("native", "user cancelled")
    await drain(iterator, events)

    expect(events.some((event) => isApprovalResolved(event) && !event.approved)).toBe(true)
    expect(events.find((event) => isApprovalResolved(event))?.reason).toBe("approval cancelled")
    expect(await backend.resolveApproval("native", required.approvalId, true)).toBeUndefined()
    expect(executed).toHaveLength(0)
  })

  test("fails a pending approval closed with the session", async () => {
    const { backend, executed } = makeNativeBackend({})
    const { events, iterator } = await startApprovalTurn(backend)
    await backend.close("native")
    await drain(iterator, events)

    expect(events.some((event) => isApprovalResolved(event) && !event.approved)).toBe(true)
    expect(events.find((event) => isApprovalResolved(event))?.reason).toBe("approval closed")
    expect(executed).toHaveLength(0)
  })

  test("times out a pending approval and reports the bounded timeout error", async () => {
    const { backend, executed } = makeNativeBackend({ approvalTimeoutMs: 5 })
    const { events, iterator } = await startApprovalTurn(backend)
    await drain(iterator, events)

    expect(events.some((event) => isApprovalResolved(event) && !event.approved)).toBe(true)
    expect(events.find((event) => isApprovalResolved(event))?.reason).toBe("approval timed out")
    const completed = events.find((event) => event.type === "tool.completed")
    expect(completed?.error?.code).toBe("APPROVAL_TIMEOUT")
    expect(executed).toHaveLength(0)
    await backend.close("native")
  })

  test("CodingAgentHost exposes and resolves native approvals through the protocol", async () => {
    const { backend, executed } = makeNativeBackend({})
    const host = new CodingAgentHost({ backend })
    await host.start({ cwd: "/workspace", sessionId: "native" })
    const iterator = host.prompt("write the file")[Symbol.asyncIterator]()
    const events: AgentEvent[] = []
    const required = await readUntil(iterator, events, isApprovalRequired)
    expect(host.pendingApprovals).toHaveLength(1)

    await host.resolveApproval(required.approvalId, true, "approved by test")
    await drain(iterator, events)

    expect(events.some((event) => isApprovalResolved(event) && event.approved)).toBe(true)
    expect(host.pendingApprovals).toHaveLength(0)
    expect(executed).toHaveLength(1)
    expect(events.map((event) => event.seq)).toEqual(
      events.map((event) => event.seq).sort((left, right) => left - right),
    )
    await host.stop()
  })

  test("default session evidence omits prompts, tool inputs, and model output", async () => {
    const root = await mkdtemp(join(tmpdir(), "nifra-native-approval-evidence-"))
    const { backend } = makeNativeBackend({})
    const host = new CodingAgentHost({
      backend,
      sessionStore: new FileSessionStore({ root }),
    })
    try {
      await host.start({ cwd: "/workspace", sessionId: "native" })
      const iterator = host.prompt("private prompt should not persist")[Symbol.asyncIterator]()
      const events: AgentEvent[] = []
      const required = await readUntil(iterator, events, isApprovalRequired)
      await host.resolveApproval(required.approvalId, true)
      await drain(iterator, events)

      const evidence = JSON.stringify(await host.history())
      expect(evidence).not.toContain("private prompt should not persist")
      expect(evidence).not.toContain("safe.txt")
      expect(evidence).not.toContain("written")
    } finally {
      await host.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})
