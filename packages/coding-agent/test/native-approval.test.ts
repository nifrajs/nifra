import { describe, expect, jest, setSystemTime, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  AgentApprovalRequiredEvent,
  AgentApprovalResolvedEvent,
  AgentEvent,
} from "@nifrajs/agent-protocol"
import { APPROVAL_NEVER_EXPIRES_AT, type ApprovalTimeout } from "../src/approvals.ts"
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
  readonly approvalTimeoutMs?: ApprovalTimeout
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

async function startApprovalTurn(
  backend: NifraBackend,
  signal: AbortSignal = new AbortController().signal,
) {
  await backend.createSession({ cwd: "/workspace", sessionId: "native" })
  const stream = backend.send({ sessionId: "native", message: "write the file", signal })
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

  test("an approve after the deadline is refused even before the late timeout timer runs", async () => {
    const { backend, executed } = makeNativeBackend({ approvalTimeoutMs: 60_000 })
    const { events, iterator, required } = await startApprovalTurn(backend)
    // A busy or suspended host: the clock passes the deadline before the timeout timer runs.
    setSystemTime(new Date(Date.now() + 120_000))
    try {
      expect(await backend.resolveApproval("native", required.approvalId, true)).toBe(false)
    } finally {
      setSystemTime()
    }
    await drain(iterator, events)

    expect(events.filter(isApprovalResolved)).toEqual([
      expect.objectContaining({ approved: false, reason: "approval timed out" }),
    ])
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

  test("an approval the host broker let expire is denied in the backend and never approved", async () => {
    const { backend, executed } = makeNativeBackend({ approvalTimeoutMs: 60_000 })
    const forwarded: { readonly approvalId: string; readonly approved: boolean }[] = []
    const resolve = backend.resolveApproval.bind(backend)
    backend.resolveApproval = (sessionId, approvalId, approved, reason) => {
      forwarded.push({ approvalId, approved })
      return resolve(sessionId, approvalId, approved, reason)
    }
    const host = new CodingAgentHost({ backend, approvals: { timeoutMs: 20 } })
    await host.start({ cwd: "/workspace", sessionId: "native" })
    const iterator = host.prompt("write the file")[Symbol.asyncIterator]()
    const events: AgentEvent[] = []
    const required = await readUntil(iterator, events, isApprovalRequired)
    const resolved = await readUntil(iterator, events, isApprovalResolved)

    expect(resolved).toMatchObject({ approvalId: required.approvalId, approved: false })
    expect(host.pendingApprovals).toHaveLength(0)
    expect(await host.resolveApproval(required.approvalId, true)).toBeUndefined()
    expect(await host.resolveApproval("never-offered", true)).toBeUndefined()
    await drain(iterator, events)

    expect(forwarded).toEqual([{ approvalId: required.approvalId, approved: false }])
    expect(executed).toHaveLength(0)
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

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS

async function withFakeTimers(run: () => Promise<void>): Promise<void> {
  jest.useFakeTimers()
  try {
    await run()
  } finally {
    jest.useRealTimers()
  }
}

/** Records every decision the host forwards to the backend. */
function forwardedDecisions(backend: NifraBackend) {
  const forwarded: { readonly approvalId: string; readonly approved: boolean }[] = []
  const resolve = backend.resolveApproval.bind(backend)
  backend.resolveApproval = (sessionId, approvalId, approved, reason) => {
    forwarded.push({ approvalId, approved })
    return resolve(sessionId, approvalId, approved, reason)
  }
  return forwarded
}

describe('NifraBackend approvalTimeoutMs: "never"', () => {
  test("an approval is still pending and answerable after more than 24 hours", () =>
    withFakeTimers(async () => {
      const { backend, executed } = makeNativeBackend({ approvalTimeoutMs: "never" })
      const { events, iterator, required } = await startApprovalTurn(backend)
      expect(jest.getTimerCount()).toBe(0)
      jest.advanceTimersByTime(DAY_MS + MINUTE_MS)
      expect(await backend.resolveApproval("native", required.approvalId, true)).toBe(true)
      await drain(iterator, events)

      expect(events.filter(isApprovalResolved).map((event) => event.approved)).toEqual([true])
      expect(events.find((event) => event.type === "tool.completed")?.ok).toBe(true)
      expect(executed).toHaveLength(1)
      await backend.close("native")
    }))

  for (const end of ["cancel", "turn end"] as const)
    test(`an approval is still denied on ${end}`, () =>
      withFakeTimers(async () => {
        const { backend, executed } = makeNativeBackend({ approvalTimeoutMs: "never" })
        const turn = new AbortController()
        const { events, iterator, required } = await startApprovalTurn(backend, turn.signal)
        jest.advanceTimersByTime(DAY_MS + MINUTE_MS)
        if (end === "cancel") await backend.cancel("native", "user cancelled")
        else turn.abort("turn ended")
        await drain(iterator, events)

        expect(events.filter(isApprovalResolved)).toEqual([
          expect.objectContaining({
            approvalId: required.approvalId,
            approved: false,
            reason: "approval cancelled",
          }),
        ])
        expect(await backend.resolveApproval("native", required.approvalId, true)).toBeUndefined()
        expect(executed).toHaveLength(0)
        await backend.close("native")
      }))

  test("an approval is still denied when its session closes", () =>
    withFakeTimers(async () => {
      const { backend, executed } = makeNativeBackend({ approvalTimeoutMs: "never" })
      const { events, iterator, required } = await startApprovalTurn(backend)
      jest.advanceTimersByTime(DAY_MS + MINUTE_MS)
      await backend.close("native")
      await drain(iterator, events)

      expect(events.filter(isApprovalResolved)).toEqual([
        expect.objectContaining({
          approvalId: required.approvalId,
          approved: false,
          reason: "approval closed",
        }),
      ])
      expect(executed).toHaveLength(0)
    }))

  test("numeric timeouts and the default still time out", () =>
    withFakeTimers(async () => {
      for (const approvalTimeoutMs of [undefined, DAY_MS]) {
        const { backend, executed } = makeNativeBackend(
          approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs },
        )
        const { events, iterator, required } = await startApprovalTurn(backend)
        jest.advanceTimersByTime((approvalTimeoutMs ?? 5 * MINUTE_MS) - 1)
        expect(events.some(isApprovalResolved)).toBe(false)
        jest.advanceTimersByTime(1)
        await drain(iterator, events)

        expect(events.find(isApprovalResolved)?.reason).toBe("approval timed out")
        expect(events.find((event) => event.type === "tool.completed")?.error?.code).toBe(
          "APPROVAL_TIMEOUT",
        )
        expect(await backend.resolveApproval("native", required.approvalId, true)).toBeUndefined()
        expect(executed).toHaveLength(0)
        await backend.close("native")
      }
    }))

  test("rejects every other approvalTimeoutMs", () => {
    const model = { complete: () => ({ type: "text" as const, text: "ok" }) }
    // As an untyped caller (plain JS, a parsed config file) would pass them.
    const invalid: readonly unknown[] = [
      0,
      -1,
      1.5,
      DAY_MS + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "forever",
      "Never",
      "",
      null,
      false,
    ]
    for (const approvalTimeoutMs of invalid)
      expect(() => Reflect.construct(NifraBackend, [{ model, approvalTimeoutMs }])).toThrow(
        RangeError,
      )
    for (const approvalTimeoutMs of [1, DAY_MS, "never"] as const)
      expect(() => new NifraBackend({ model, approvalTimeoutMs })).not.toThrow()
  })

  test("through CodingAgentHost, an approval survives past 5 minutes and is not denied in the backend", () =>
    withFakeTimers(async () => {
      const { backend, executed } = makeNativeBackend({ approvalTimeoutMs: "never" })
      const forwarded = forwardedDecisions(backend)
      const host = new CodingAgentHost({ backend, approvals: { timeoutMs: "never" } })
      await host.start({ cwd: "/workspace", sessionId: "native" })
      const iterator = host.prompt("write the file")[Symbol.asyncIterator]()
      const events: AgentEvent[] = []
      const required = await readUntil(iterator, events, isApprovalRequired)
      jest.advanceTimersByTime(DAY_MS + MINUTE_MS)

      expect(host.pendingApprovals.map(({ id, expiresAt }) => ({ id, expiresAt }))).toEqual([
        { id: required.approvalId, expiresAt: APPROVAL_NEVER_EXPIRES_AT },
      ])
      expect(forwarded).toEqual([])
      expect((await host.resolveApproval(required.approvalId, true))?.approved).toBe(true)
      await drain(iterator, events)

      expect(forwarded).toEqual([{ approvalId: required.approvalId, approved: true }])
      expect(events.filter(isApprovalResolved).map((event) => event.approved)).toEqual([true])
      expect(executed).toHaveLength(1)
      await host.stop()
    }))

  test("through CodingAgentHost, a turn its reader abandons denies the approval in both", () =>
    withFakeTimers(async () => {
      const { backend, executed } = makeNativeBackend({ approvalTimeoutMs: "never" })
      const forwarded = forwardedDecisions(backend)
      const host = new CodingAgentHost({ backend, approvals: { timeoutMs: "never" } })
      await host.start({ cwd: "/workspace", sessionId: "native" })
      const iterator = host.prompt("write the file")[Symbol.asyncIterator]()
      const required = await readUntil(iterator, [], isApprovalRequired)
      jest.advanceTimersByTime(DAY_MS + MINUTE_MS)
      // What the RPC server does when the client of a non-resumable turn disconnects.
      await iterator.return?.()
      await backend.cancel("native", "client disconnected")

      expect(host.pendingApprovals).toHaveLength(0)
      expect(await host.resolveApproval(required.approvalId, true)).toBeUndefined()
      expect(forwarded).toEqual([{ approvalId: required.approvalId, approved: false }])
      expect(executed).toHaveLength(0)
      await host.stop()
    }))

  test("through CodingAgentHost, stopping the host denies the approval in both", () =>
    withFakeTimers(async () => {
      const { backend, executed } = makeNativeBackend({ approvalTimeoutMs: "never" })
      const host = new CodingAgentHost({ backend, approvals: { timeoutMs: "never" } })
      await host.start({ cwd: "/workspace", sessionId: "native" })
      const iterator = host.prompt("write the file")[Symbol.asyncIterator]()
      const events: AgentEvent[] = []
      await readUntil(iterator, events, isApprovalRequired)
      jest.advanceTimersByTime(DAY_MS + MINUTE_MS)
      await host.stop()
      await iterator.return?.()

      expect(host.pendingApprovals).toHaveLength(0)
      expect(executed).toHaveLength(0)
    }))
})
