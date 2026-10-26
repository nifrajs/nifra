import { describe, expect, jest, setSystemTime, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  AgentApprovalRequiredEvent,
  AgentApprovalResolvedEvent,
  AgentEvent,
} from "@nifrajs/agent-protocol"
import { APPROVAL_NEVER_EXPIRES_AT } from "../src/approvals.ts"
import { CodingAgentHost } from "../src/host.ts"
import {
  type NativeApprovalPort,
  type NativeApprovalRequest,
  type NativeModelRequest,
  type NativeReviewAnswer,
  NifraBackend,
  type NifraBackendOptions,
} from "../src/native.ts"
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

function makeNativeBackend({
  execute,
  ...backendOptions
}: Pick<NifraBackendOptions, "approval" | "approvalTimeoutMs" | "reviewTimeoutMs"> & {
  readonly execute?: (input: unknown, context: { readonly signal: AbortSignal }) => unknown
}) {
  const executed: unknown[] = []
  const requests: NativeModelRequest[] = []
  const backend = new NifraBackend({
    model: {
      complete: (request) => {
        requests.push(request)
        return request.messages.some((message) => message.role === "tool")
          ? { type: "text", text: "done" }
          : { type: "tool", name: "write_file", input: { path: "safe.txt" } }
      },
    },
    tools: [
      {
        name: "write_file",
        description: "Write a file in the authorized workspace",
        capabilities: ["filesystem.write"],
        requiresApproval: true,
        execute: (input, context) => {
          executed.push(input)
          return execute?.(input, { signal: context.signal }) ?? "written"
        },
      },
    ],
    ...backendOptions,
  })
  /** What the model was told about the tool call in its latest request. */
  const toolMessage = (): string | undefined =>
    requests.at(-1)?.messages.find((message) => message.role === "tool")?.text
  return { backend, executed, requests, toolMessage }
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
    const { backend, executed, toolMessage } = makeNativeBackend({})
    const { events, iterator, required } = await startApprovalTurn(backend)
    expect(
      await backend.resolveApproval("native", required.approvalId, false, "x".repeat(10_000)),
    ).toBe(false)
    await drain(iterator, events)

    const completed = events.find((event) => event.type === "tool.completed")
    expect(completed?.ok).toBe(false)
    expect(completed?.error?.code).toBe("APPROVAL_DENIED")
    expect(completed?.error?.message.length).toBeLessThanOrEqual(512)
    expect(toolMessage()).toStartWith("APPROVAL_DENIED: approval denied for write_file: xxx")
    expect(toolMessage()?.length).toBeLessThanOrEqual(512)
    expect(executed).toHaveLength(0)
    await backend.close("native")
  })

  test("a denial's reason reaches the model's next request", async () => {
    const { backend, executed, requests, toolMessage } = makeNativeBackend({})
    const { events, iterator, required } = await startApprovalTurn(backend)
    await backend.resolveApproval("native", required.approvalId, false, "write under tmp/ instead")
    await drain(iterator, events)

    const completed = events.find((event) => event.type === "tool.completed")
    expect(requests).toHaveLength(2)
    expect(toolMessage()).toBe(
      "APPROVAL_DENIED: approval denied for write_file: write under tmp/ instead",
    )
    expect(toolMessage()).toBe(`${completed?.error?.code}: ${completed?.error?.message}`)
    expect(executed).toHaveLength(0)
    await backend.close("native")
  })

  const unexplained: ReadonlyArray<{
    readonly name: string
    readonly options: Parameters<typeof makeNativeBackend>[0]
    readonly answer?: (backend: NifraBackend, approvalId: string) => Promise<unknown>
    readonly expected: string
  }> = [
    {
      name: "a denial with no reason",
      options: {},
      answer: (backend, id) => backend.resolveApproval("native", id, false),
      expected: "APPROVAL_DENIED: approval denied for write_file",
    },
    {
      name: "a denial with a blank reason",
      options: {},
      answer: (backend, id) => backend.resolveApproval("native", id, false, "  "),
      expected: "APPROVAL_DENIED: approval denied for write_file",
    },
    {
      name: "a timeout",
      options: { approvalTimeoutMs: 5 },
      expected: "APPROVAL_TIMEOUT: approval timed out for write_file",
    },
    {
      name: "a port that answers false",
      options: { approval: { request: () => false } },
      expected: "APPROVAL_DENIED: approval denied for write_file",
    },
    {
      name: "a port that rejects",
      options: { approval: { request: () => Promise.reject(new Error("broker down")) } },
      expected: "APPROVAL_FAILED: approval failed for write_file: approval callback failed",
    },
  ]
  for (const { name, options, answer, expected } of unexplained)
    test(`the model reads ${name} as one plain line`, async () => {
      const { backend, executed, toolMessage } = makeNativeBackend(options)
      const { events, iterator, required } = await startApprovalTurn(backend)
      await answer?.(backend, required.approvalId)
      await drain(iterator, events)

      expect(toolMessage()).toBe(expected)
      expect(executed).toHaveLength(0)
      await backend.close("native")
    })

  test("fails a pending approval closed on cancellation", async () => {
    const { backend, executed, requests } = makeNativeBackend({})
    const { events, iterator, required } = await startApprovalTurn(backend)
    await backend.cancel("native", "user cancelled")
    await drain(iterator, events)

    expect(events.some((event) => isApprovalResolved(event) && !event.approved)).toBe(true)
    expect(events.find((event) => isApprovalResolved(event))?.reason).toBe("approval cancelled")
    expect(events.at(-1)?.type).toBe("session.stopped")
    expect(await backend.resolveApproval("native", required.approvalId, true)).toBeUndefined()
    expect(requests).toHaveLength(1)
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

/**
 * A port whose review answers with `answer` and whose request approves, recording every call. A
 * review that has started resolves `reviewing`, so a test can act while it is still unsettled.
 */
function reviewingPort(
  answer: (input: NativeApprovalRequest) => NativeReviewAnswer | PromiseLike<NativeReviewAnswer>,
) {
  const reviewed: NativeApprovalRequest[] = []
  const requested: NativeApprovalRequest[] = []
  const reviewing = deferred<NativeApprovalRequest>()
  const port: NativeApprovalPort = {
    request: (input) => {
      requested.push(input)
      return true
    },
    review: (input) => {
      reviewed.push(input)
      reviewing.resolve(input)
      return answer(input)
    },
  }
  return { port, reviewed, requested, reviewing: reviewing.promise }
}

async function runTurn(backend: NifraBackend, signal?: AbortSignal) {
  await backend.createSession({ cwd: "/workspace", sessionId: "native" })
  const events: AgentEvent[] = []
  const iterator = backend
    .send({ sessionId: "native", message: "write the file", ...(signal ? { signal } : {}) })
    [Symbol.asyncIterator]()
  return { events, iterator }
}

const approvalEvents = (events: readonly AgentEvent[]) =>
  events.filter((event) => event.type.startsWith("approval."))

describe("NifraBackend approval review", () => {
  test("an allow runs the tool with no approval events", async () => {
    const { port, reviewed, requested } = reviewingPort(() => ({ decision: "allow" }))
    const { backend, executed } = makeNativeBackend({ approval: port })
    const { events, iterator } = await runTurn(backend)
    await drain(iterator, events)

    const started = events.find((event) => event.type === "tool.started")
    const completed = events.find((event) => event.type === "tool.completed")
    expect(reviewed).toEqual([
      expect.objectContaining({
        sessionId: "native",
        callId: started?.type === "tool.started" ? started.callId : "missing",
        action: "write_file",
        capability: "filesystem.write",
        input: { path: "safe.txt" },
      }),
    ])
    expect(reviewed[0]?.approvalId).toMatch(/^nifra-approval-[A-Za-z0-9-]{36}$/)
    expect(completed?.ok).toBe(true)
    expect(executed).toEqual([{ path: "safe.txt" }])
    expect(approvalEvents(events)).toEqual([])
    expect(requested).toEqual([])
    expect(events.at(-1)?.type).toBe("session.completed")
    await backend.close("native")
  })

  test("a deny refuses the tool and its reason reaches the event and the model", async () => {
    const { port, requested } = reviewingPort(async () => ({
      decision: "deny",
      reason: "writes outside src/ need a person",
    }))
    const { backend, executed, toolMessage } = makeNativeBackend({ approval: port })
    const { events, iterator } = await runTurn(backend)
    await drain(iterator, events)

    const completed = events.find((event) => event.type === "tool.completed")
    expect(completed?.ok).toBe(false)
    expect(completed?.error).toEqual({
      code: "REVIEW_DENIED",
      message: "review denied for write_file: writes outside src/ need a person",
    })
    expect(toolMessage()).toBe(
      "REVIEW_DENIED: review denied for write_file: writes outside src/ need a person",
    )
    expect(executed).toEqual([])
    expect(approvalEvents(events)).toEqual([])
    expect(requested).toEqual([])
    await backend.close("native")
  })

  test("a deny's reason is bounded and a blank one is left out", async () => {
    for (const [reason, expected] of [
      ["y".repeat(10_000), undefined],
      [" ", "REVIEW_DENIED: review denied for write_file"],
    ] as const) {
      const { port } = reviewingPort(() => ({ decision: "deny", reason }))
      const { backend, toolMessage } = makeNativeBackend({ approval: port })
      const { events, iterator } = await runTurn(backend)
      await drain(iterator, events)

      const completed = events.find((event) => event.type === "tool.completed")
      expect(completed?.error?.message.length).toBeLessThanOrEqual(512)
      expect(toolMessage()?.length).toBeLessThanOrEqual(512)
      if (expected !== undefined) expect(toolMessage()).toBe(expected)
      await backend.close("native")
    }
  })

  test("an ask raises the approval the review saw, and request decides it", async () => {
    const { port, reviewed, requested } = reviewingPort(() => ({ decision: "ask" }))
    const { backend, executed } = makeNativeBackend({ approval: port })
    const { events, iterator } = await runTurn(backend)
    await drain(iterator, events)

    const required = events.find(isApprovalRequired)
    expect(required?.approvalId).toBe(reviewed[0]?.approvalId ?? "missing")
    expect(reviewed).toHaveLength(1)
    expect(requested).toEqual(reviewed)
    expect(events.find(isApprovalResolved)?.approved).toBe(true)
    expect(executed).toHaveLength(1)
    await backend.close("native")
  })

  const notAnswers: ReadonlyArray<readonly [string, () => unknown]> = [
    [
      "a throw",
      () => {
        throw new Error("reviewer crashed")
      },
    ],
    ["a rejection", () => Promise.reject(new Error("reviewer unavailable"))],
    ["undefined", () => undefined],
    ["null", () => null],
    ["a bare string", () => "allow"],
    ["true", () => true],
    ["an array", () => ["allow"]],
    ["an unknown decision", () => ({ decision: "yes" })],
    ["a differently cased decision", () => ({ decision: "Allow" })],
    ["a deny with no reason", () => ({ decision: "deny" })],
    ["a deny with a reason that is not a string", () => ({ decision: "deny", reason: 7 })],
    [
      "an answer whose decision getter throws",
      () => ({
        get decision(): string {
          throw new Error("trap")
        },
      }),
    ],
    [
      "a thenable whose then throws",
      () => ({
        // biome-ignore lint/suspicious/noThenProperty: the review answers with a hostile thenable.
        then() {
          throw new Error("trap")
        },
      }),
    ],
  ]
  for (const [name, answer] of notAnswers)
    test(`${name} counts as ask`, async () => {
      const { port, requested } = reviewingPort(
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the answer is deliberately outside the type, as an untyped review (plain JS, a model's parsed output) would give it.
        answer as () => NativeReviewAnswer,
      )
      const { backend, executed } = makeNativeBackend({ approval: port })
      const { events, iterator } = await runTurn(backend)
      await drain(iterator, events)

      expect(events.filter(isApprovalRequired)).toHaveLength(1)
      expect(requested).toHaveLength(1)
      expect(executed).toHaveLength(1)
      await backend.close("native")
    })

  for (const end of ["cancel", "turn signal", "close"] as const)
    test(`a ${end} during a review stops the turn and ignores a later allow`, async () => {
      const answer = deferred<NativeReviewAnswer>()
      const { port, requested, reviewing } = reviewingPort(() => answer.promise)
      const { backend, executed, requests } = makeNativeBackend({ approval: port })
      const turn = new AbortController()
      const { events, iterator } = await runTurn(backend, turn.signal)
      const done = drain(iterator, events)
      await reviewing
      if (end === "cancel") await backend.cancel("native", "user cancelled")
      else if (end === "turn signal") turn.abort("turn ended")
      else await backend.close("native")
      answer.resolve({ decision: "allow" })
      await done
      await Bun.sleep(0)

      expect(executed).toEqual([])
      expect(approvalEvents(events)).toEqual([])
      expect(requested).toEqual([])
      expect(requests).toHaveLength(1)
      expect(events.some((event) => event.type === "tool.completed")).toBe(false)
      if (end !== "close") expect(events.at(-1)?.type).toBe("session.stopped")
      if (end !== "close") await backend.close("native")
    })

  test("an abort releases a review that never settles at once", () =>
    withFakeTimers(async () => {
      const { port, requested, reviewing } = reviewingPort(() => new Promise(() => {}))
      const { backend, executed } = makeNativeBackend({ approval: port })
      const { events, iterator } = await runTurn(backend)
      const done = drain(iterator, events)
      await reviewing
      expect(jest.getTimerCount()).toBe(1)
      await backend.cancel("native", "user cancelled")
      await done

      expect(jest.getTimerCount()).toBe(0)
      expect(events.at(-1)?.type).toBe("session.stopped")
      expect(approvalEvents(events)).toEqual([])
      expect(requested).toEqual([])
      expect(executed).toEqual([])
      await backend.close("native")
    }))

  test("a review that never settles goes on to an approval after reviewTimeoutMs", () =>
    withFakeTimers(async () => {
      const { port, requested, reviewing } = reviewingPort(() => new Promise(() => {}))
      const { backend, executed } = makeNativeBackend({ approval: port, reviewTimeoutMs: 1_000 })
      const { events, iterator } = await runTurn(backend)
      const required = readUntil(iterator, events, isApprovalRequired)
      await reviewing
      jest.advanceTimersByTime(999)
      expect(requested).toEqual([])
      jest.advanceTimersByTime(1)
      await required
      await drain(iterator, events)

      expect(requested).toHaveLength(1)
      expect(executed).toHaveLength(1)
      await backend.close("native")
    }))

  test("the default reviewTimeoutMs is 30 s", () =>
    withFakeTimers(async () => {
      const { port, requested, reviewing } = reviewingPort(() => new Promise(() => {}))
      const { backend } = makeNativeBackend({ approval: port })
      const { events, iterator } = await runTurn(backend)
      const required = readUntil(iterator, events, isApprovalRequired)
      await reviewing
      jest.advanceTimersByTime(29_999)
      expect(requested).toEqual([])
      jest.advanceTimersByTime(1)
      await required
      expect(requested).toHaveLength(1)
      await backend.close("native")
    }))

  test("an allow that arrives after the deadline, before the late timer, still asks", async () => {
    const answer = deferred<NativeReviewAnswer>()
    const { port, requested, reviewing } = reviewingPort(() => answer.promise)
    const { backend } = makeNativeBackend({ approval: port, reviewTimeoutMs: 60_000 })
    const { events, iterator } = await runTurn(backend)
    await reviewing
    // A busy or suspended host: the clock passes the deadline before the timeout timer runs.
    setSystemTime(new Date(Date.now() + 120_000))
    try {
      answer.resolve({ decision: "allow" })
      const required = await readUntil(iterator, events, isApprovalRequired)
      expect(requested.map((input) => input.approvalId)).toEqual([required.approvalId])
    } finally {
      setSystemTime()
    }
    await backend.close("native")
  })

  test("concurrent calls are reviewed apart, and an allow approves only its own call", async () => {
    const answers = new Map<string, ReturnType<typeof deferred<NativeReviewAnswer>>>()
    const reviewed: NativeApprovalRequest[] = []
    const both = deferred<void>()
    const { backend, executed } = makeNativeBackend({
      approval: {
        request: () => true,
        review: (input) => {
          reviewed.push(input)
          const answer = deferred<NativeReviewAnswer>()
          answers.set(input.sessionId, answer)
          if (answers.size === 2) both.resolve()
          return answer.promise
        },
      },
    })
    const turns = await Promise.all(
      ["a", "b"].map(async (sessionId) => {
        await backend.createSession({ cwd: "/workspace", sessionId })
        const events: AgentEvent[] = []
        const iterator = backend.send({ sessionId, message: "write" })[Symbol.asyncIterator]()
        return { events, done: drain(iterator, events) }
      }),
    )
    await both.promise
    answers.get("a")?.resolve({ decision: "allow" })
    await turns[0]?.done
    expect(executed).toHaveLength(1)
    expect(turns[1]?.events.some((event) => event.type === "tool.completed")).toBe(false)

    answers.get("b")?.resolve({ decision: "deny", reason: "not this one" })
    await turns[1]?.done
    expect(executed).toHaveLength(1)
    expect(turns[1]?.events.find((event) => event.type === "tool.completed")?.error?.code).toBe(
      "REVIEW_DENIED",
    )
    expect(new Set(reviewed.map((input) => input.approvalId)).size).toBe(2)
    expect(new Set(reviewed.map((input) => input.callId)).size).toBe(2)
    await backend.close("a")
    await backend.close("b")
  })

  test("rejects a reviewTimeoutMs outside 1 ms to 10 minutes", () => {
    const model = { complete: () => ({ type: "text" as const, text: "ok" }) }
    const invalid: readonly unknown[] = [0, -1, 1.5, 10 * MINUTE_MS + 1, Number.NaN, "never", null]
    for (const reviewTimeoutMs of invalid)
      expect(() => Reflect.construct(NifraBackend, [{ model, reviewTimeoutMs }])).toThrow(
        RangeError,
      )
    for (const reviewTimeoutMs of [1, 10 * MINUTE_MS])
      expect(() => new NifraBackend({ model, reviewTimeoutMs })).not.toThrow()
  })
})
