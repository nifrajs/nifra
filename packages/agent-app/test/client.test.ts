import { describe, expect, test } from "bun:test"
import type { AgentEvent, AgentSessionSnapshot } from "@nifrajs/agent-protocol"
import { AgentAppClient, AgentAppError } from "../src/client.ts"
import {
  type AgentTransport,
  AgentTransportError,
  type AgentTransportRequest,
  type CommandOutcome,
} from "../src/transport.ts"
import { OrderedEventBuffer, toEventView } from "../src/view-models.ts"

const snapshot = (overrides: Partial<AgentSessionSnapshot> = {}): AgentSessionSnapshot => ({
  version: 1,
  id: "session-1",
  backend: "fake",
  cwd: "/secret/path",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  lastSeq: 0,
  capabilities: ["approvals", "resume", "workflows"],
  ...overrides,
})

const delta = (seq: number, text: string): AgentEvent => ({
  version: 1,
  sessionId: "session-1",
  seq,
  at: seq,
  type: "assistant.delta",
  turnId: "turn-1",
  text,
})

class FakeTransport implements AgentTransport {
  readonly calls: AgentTransportRequest[] = []
  constructor(
    private readonly onCommand: (request: AgentTransportRequest) => CommandOutcome<unknown>,
    private readonly events: readonly AgentEvent[] = [],
  ) {}
  async command<T>(request: AgentTransportRequest): Promise<CommandOutcome<T>> {
    this.calls.push(request)
    return this.onCommand(request) as CommandOutcome<T>
  }
  async *stream(request: AgentTransportRequest): AsyncIterable<AgentEvent> {
    this.calls.push(request)
    for (const event of this.events) yield event
  }
}

describe("AgentAppClient session + negotiation", () => {
  test("createSession negotiates the granted feature set and hides the cwd", async () => {
    const transport = new FakeTransport(() => ({ ok: true, status: 200, value: snapshot() }))
    const client = new AgentAppClient(transport)
    const view = await client.createSession({ cwd: "/secret/path" })
    expect(view.id).toBe("session-1")
    expect(view).not.toHaveProperty("cwd")
    // requested ∩ advertised, sorted.
    expect(client.features).toEqual(["approvals", "resume", "workflows"])
    expect(client.supports("workflows")).toBe(true)
    expect(client.supports("fork")).toBe(false)
  })

  test("requireFeature throws for an ungranted feature", async () => {
    const transport = new FakeTransport(() => ({
      ok: true,
      status: 200,
      value: snapshot({ capabilities: [] }),
    }))
    const client = new AgentAppClient(transport)
    await client.createSession()
    expect(() => client.requireFeature("resume")).toThrow(AgentAppError)
  })

  test("negotiates the optional run studio surface", async () => {
    const transport = new FakeTransport(() => ({
      ok: true,
      status: 200,
      value: snapshot({ capabilities: ["run-studio"] }),
    }))
    const client = new AgentAppClient(transport)
    await client.createSession()
    expect(client.supports("run-studio")).toBe(true)
  })

  test("a session command error surfaces as AgentAppError, never a raw throw of the credential", async () => {
    const transport = new FakeTransport(() => ({ ok: false, status: 401, error: "unauthorized" }))
    const client = new AgentAppClient(transport)
    await expect(client.createSession()).rejects.toThrow(/session.create failed \(401\)/)
  })
})

describe("AgentAppClient.send", () => {
  test("orders and deduplicates the live stream into content-free views", async () => {
    const events = [delta(1, "he"), delta(3, "lo"), delta(2, "l"), delta(2, "dup"), delta(4, "!")]
    const transport = new FakeTransport(
      () => ({ ok: true, status: 200, value: snapshot() }),
      events,
    )
    const client = new AgentAppClient(transport)
    await client.createSession()
    const seen: Array<{ seq: number; chars: number }> = []
    for await (const view of client.send("hi")) {
      expect(view).not.toHaveProperty("text")
      if (view.kind === "assistant.delta") seen.push({ seq: view.seq, chars: view.chars })
    }
    expect(seen.map((v) => v.seq)).toEqual([1, 2, 3, 4])
    // chars come from the first delivery of each seq; the duplicate seq 2 ("dup") is dropped.
    expect(seen.find((v) => v.seq === 2)?.chars).toBe(1)
    expect(transport.calls.at(-1)?.method).toBe("turn.send")
  })

  test("each turn continues from the last seq the previous turn delivered", async () => {
    let next = 0
    class CountingTransport extends FakeTransport {
      override async *stream(): AsyncIterable<AgentEvent> {
        for (let i = 0; i < 3; i++) {
          next += 1
          yield delta(next, "x")
        }
      }
    }
    const client = new AgentAppClient(
      new CountingTransport(() => ({ ok: true, status: 200, value: snapshot() })),
    )
    await client.createSession()
    for (const expected of [
      [1, 2, 3],
      [4, 5, 6],
    ]) {
      const seen: number[] = []
      for await (const view of client.send("hi")) seen.push(view.seq)
      expect(seen).toEqual(expected)
    }
  })

  test("a turn that starts past seqs another client's turns used streams live", async () => {
    const gate = Promise.withResolvers<void>()
    class SharedSessionTransport extends FakeTransport {
      override async *stream(): AsyncIterable<AgentEvent> {
        yield delta(5, "a")
        await gate.promise
        yield delta(6, "b")
      }
    }
    const client = new AgentAppClient(
      new SharedSessionTransport(() => ({ ok: true, status: 200, value: snapshot() })),
    )
    await client.createSession()
    const views = client.send("hi")[Symbol.asyncIterator]()
    expect((await views.next()).value?.seq).toBe(5)
    gate.resolve()
    expect((await views.next()).value?.seq).toBe(6)
    expect((await views.next()).done).toBe(true)
    expect(client.session?.lastSeq).toBe(6)
  })

  test("events held behind a gap the stream never fills are released when it ends", async () => {
    const transport = new FakeTransport(
      () => ({ ok: true, status: 200, value: snapshot() }),
      [delta(1, "a"), delta(3, "c"), delta(5, "e")],
    )
    const client = new AgentAppClient(transport)
    await client.createSession()
    const seen: number[] = []
    for await (const view of client.send("hi")) seen.push(view.seq)
    expect(seen).toEqual([1, 3, 5])
    expect(client.session?.lastSeq).toBe(5)
  })

  test("a redelivered event at or below the last seen seq is still dropped", async () => {
    const transport = new FakeTransport(
      () => ({ ok: true, status: 200, value: snapshot({ lastSeq: 4 }) }),
      [delta(3, "old"), delta(5, "new")],
    )
    const client = new AgentAppClient(transport)
    await client.createSession()
    const seen: number[] = []
    for await (const view of client.send("hi")) seen.push(view.seq)
    expect(seen).toEqual([5])
  })

  test("send before createSession is rejected", async () => {
    const transport = new FakeTransport(() => ({ ok: true, status: 200, value: snapshot() }))
    const client = new AgentAppClient(transport)
    const drain = (async () => {
      for await (const _ of client.send("hi")) void _
    })()
    await expect(drain).rejects.toThrow(AgentAppError)
  })
})

describe("AgentAppClient.resume", () => {
  const withResume = (value: unknown) =>
    new AgentAppClient(
      new FakeTransport((request) =>
        request.method === "session.create"
          ? { ok: true, status: 200, value: snapshot() }
          : { ok: true, status: 200, value },
      ),
    )

  test("projects a persisted window to ordering + type only, dropping payloads", async () => {
    const client = withResume({
      snapshot: snapshot(),
      resume: {
        status: "ok",
        nextCursor: 5,
        events: [
          { seq: 4, at: 40, type: "session.checkpoint", payload: { secret: "x" } },
          { seq: 5, at: 50, type: "turn.started", payload: { prompt: "leak" } },
        ],
      },
    })
    await client.createSession()
    const result = await client.resume({ cursor: 3, limit: 10 })
    expect(result.status).toBe("ok")
    if (result.status !== "ok") throw new Error("unreachable")
    expect(result.nextCursor).toBe(5)
    expect(result.entries).toEqual([
      { seq: 4, at: 40, type: "session.checkpoint" },
      { seq: 5, at: 50, type: "turn.started" },
    ])
    for (const entry of result.entries) expect(entry).not.toHaveProperty("payload")
  })

  test("surfaces a resync request from a stale cursor", async () => {
    const client = withResume({
      resume: { status: "resync_required", reason: "stale_cursor", earliest: 8, latest: 12 },
    })
    await client.createSession()
    const result = await client.resume({ cursor: 0 })
    expect(result).toEqual({
      status: "resync_required",
      reason: "stale_cursor",
      earliest: 8,
      latest: 12,
    })
  })

  test("resume requires the granted feature", async () => {
    const client = new AgentAppClient(
      new FakeTransport(() => ({
        ok: true,
        status: 200,
        value: snapshot({ capabilities: [] }),
      })),
    )
    await client.createSession()
    await expect(client.resume()).rejects.toThrow(/did not grant the "resume"/)
  })
})

describe("AgentAppClient approvals", () => {
  test("reads an approval an older host names `id`", async () => {
    const transport = new FakeTransport((request) =>
      request.method === "session.create"
        ? { ok: true, status: 200, value: snapshot() }
        : {
            ok: true,
            status: 200,
            value: { pending: [{ id: "a1", action: "write file", capability: "filesystem" }] },
          },
    )
    const client = new AgentAppClient(transport)
    await client.createSession()
    expect(await client.listApprovals()).toEqual([
      { approvalId: "a1", action: "write file", capability: "filesystem" },
    ])
  })

  test("lists pending approvals as identifiers and records a decision", async () => {
    const transport = new FakeTransport((request) => {
      switch (request.method) {
        case "session.create":
          return { ok: true, status: 200, value: snapshot() }
        case "approval.list":
          return {
            ok: true,
            status: 200,
            value: {
              pending: [
                { approvalId: "a1", action: "write file", capability: "filesystem", extra: "x" },
              ],
            },
          }
        case "approval.resolve":
          return { ok: true, status: 200, value: { approved: true } }
        default:
          return { ok: false, status: 404, error: "unknown" }
      }
    })
    const client = new AgentAppClient(transport)
    await client.createSession()
    const pending = await client.listApprovals()
    expect(pending).toEqual([{ approvalId: "a1", action: "write file", capability: "filesystem" }])
    expect(await client.resolveApproval("a1", true)).toBe(true)
    const resolveCall = transport.calls.find((c) => c.method === "approval.resolve")
    expect(resolveCall?.params).toEqual({ approvalId: "a1", approved: true })
  })
})

describe("OrderedEventBuffer gap recovery", () => {
  test("skips an unfilled gap once maxPending is exceeded and counts the drop", () => {
    const buffer = new OrderedEventBuffer({ from: 0, maxPending: 2 })
    const view = (seq: number) => toEventView(delta(seq, "x"))
    expect(buffer.offer(view(1)).map((v) => v.seq)).toEqual([1])
    // seq 2 missing; hold 3,4 -> still within maxPending, nothing emitted.
    expect(buffer.offer(view(3))).toEqual([])
    expect(buffer.offer(view(4))).toEqual([])
    // a third pending exceeds maxPending: skip to the lowest held seq (3), emit 3,4.
    expect(buffer.offer(view(6)).map((v) => v.seq)).toEqual([3, 4])
    expect(buffer.dropped).toBeGreaterThan(0)
    expect(buffer.offer(view(6))).toEqual([]) // duplicate of an already-buffered seq
  })

  test("flush releases every held event in order and counts the missing seqs", () => {
    const buffer = new OrderedEventBuffer({ from: 0 })
    const view = (seq: number) => toEventView(delta(seq, "x"))
    expect(buffer.offer(view(4))).toEqual([])
    expect(buffer.offer(view(2))).toEqual([])
    expect(buffer.flush().map((v) => v.seq)).toEqual([2, 4])
    expect(buffer.dropped).toBe(2)
    expect(buffer.expected).toBe(5)
    expect(buffer.offer(view(3))).toEqual([])
    expect(buffer.flush()).toEqual([])
  })
})

describe("AgentAppClient.send resumes a broken turn", () => {
  const completed = (seq: number): AgentEvent => ({
    version: 1,
    sessionId: "session-1",
    seq,
    at: seq,
    type: "session.completed",
    snapshot: snapshot({ lastSeq: seq }),
  })
  const reset = (method: string) => new AgentTransportError(method, "connection reset")

  /** Each stream call plays the next script; a script throws to break its connection. */
  class ScriptedTransport extends FakeTransport {
    constructor(private readonly scripts: Array<() => AsyncIterable<AgentEvent>>) {
      super(() => ({ ok: true, status: 200, value: snapshot() }))
    }
    override stream(request: AgentTransportRequest): AsyncIterable<AgentEvent> {
      this.calls.push(request)
      const script = this.scripts.shift()
      if (script === undefined) throw new Error("no script left")
      return script()
    }
  }

  async function run(transport: ScriptedTransport, resumeAttempts?: number) {
    const client = new AgentAppClient(
      transport,
      resumeAttempts === undefined ? { resumeDelayMs: 0 } : { resumeDelayMs: 0, resumeAttempts },
    )
    await client.createSession()
    const seqs: number[] = []
    try {
      for await (const view of client.send("hi")) seqs.push(view.seq)
      return { seqs, error: undefined, calls: transport.calls.slice(1) }
    } catch (error) {
      return { seqs, error, calls: transport.calls.slice(1) }
    }
  }

  test("re-attaches from the last seq it received and goes on without a repeat", async () => {
    const transport = new ScriptedTransport([
      async function* () {
        yield delta(1, "a")
        yield delta(2, "b")
        throw reset("turn.send")
      },
      async function* () {
        yield delta(2, "b")
        yield delta(3, "c")
        yield completed(4)
      },
    ])
    const { seqs, error, calls } = await run(transport)
    expect(error).toBeUndefined()
    expect(seqs).toEqual([1, 2, 3, 4])
    expect(calls.map((call) => [call.method, call.params])).toEqual([
      ["turn.send", { message: "hi" }],
      ["turn.attach", { afterSeq: 2 }],
    ])
  })

  test("a host that refuses the attach gets the original break thrown", async () => {
    const broken = reset("turn.send")
    const transport = new ScriptedTransport([
      async function* () {
        yield delta(1, "a")
        throw broken
      },
      // biome-ignore lint/correctness/useYield: the refusal comes before any event.
      async function* () {
        throw new AgentTransportError("turn.attach", "feature_unsupported", 501)
      },
    ])
    const { seqs, error, calls } = await run(transport)
    expect(seqs).toEqual([1])
    expect(error).toBe(broken)
    expect(calls).toHaveLength(2)
  })

  test("stops after resumeAttempts breaks without progress", async () => {
    const breaks = [1, 2, 3].map(
      () =>
        // biome-ignore lint/correctness/useYield: each attach breaks before any event.
        async function* (): AsyncIterable<AgentEvent> {
          throw reset("turn.attach")
        },
    )
    const transport = new ScriptedTransport([
      async function* () {
        yield delta(1, "a")
        throw reset("turn.send")
      },
      ...breaks,
    ])
    const { error, calls } = await run(transport, 2)
    expect(error).toBeInstanceOf(AgentTransportError)
    expect(calls.map((call) => call.method)).toEqual(["turn.send", "turn.attach", "turn.attach"])
  })

  test("resumeAttempts 0, a refusal, or a break before any event is thrown as it is", async () => {
    const before = reset("turn.send")
    const refused = new AgentTransportError("turn.send", "turn_running", 409)
    for (const [error, resumeAttempts] of [
      [before, 3],
      [refused, 3],
      [reset("turn.send"), 0],
    ] as const) {
      const transport = new ScriptedTransport([
        async function* () {
          if (error !== before) yield delta(1, "a")
          throw error
        },
      ])
      const outcome = await run(transport, resumeAttempts)
      expect(outcome.error).toBe(error)
      expect(outcome.calls).toHaveLength(1)
    }
  })

  test("refuses a negative resume option", () => {
    const transport = new ScriptedTransport([])
    expect(() => new AgentAppClient(transport, { resumeAttempts: -1 })).toThrow("resumeAttempts")
    expect(() => new AgentAppClient(transport, { resumeDelayMs: 0.5 })).toThrow("resumeDelayMs")
  })
})
